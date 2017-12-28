/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import URI from 'vs/base/common/uri';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { disposed } from 'vs/base/common/errors';
import { TPromise } from 'vs/base/common/winjs.base';
import { ISingleEditOperation, IDecorationRenderOptions, IDecorationOptions, ILineChange, ICommonCodeEditor, isCommonCodeEditor } from 'vs/editor/common/editorCommon';
import { ICodeEditorService } from 'vs/editor/common/services/codeEditorService';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IEditorGroupService } from 'vs/workbench/services/group/common/groupService';
import { Position as EditorPosition, ITextEditorOptions } from 'vs/platform/editor/common/editor';
import { MainThreadTextEditor } from './mainThreadEditor';
import { ITextEditorConfigurationUpdate, TextEditorRevealType, IApplyEditsOptions, IUndoStopOptions } from 'vs/workbench/api/node/extHost.protocol';
import { MainThreadDocumentsAndEditors } from './mainThreadDocumentsAndEditors';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { equals as objectEquals } from 'vs/base/common/objects';
import { ExtHostContext, MainThreadEditorsShape, ExtHostEditorsShape, ITextDocumentShowOptions, ITextEditorPositionData, IExtHostContext, IWorkspaceResourceEdit } from '../node/extHost.protocol';
import { IRange } from 'vs/editor/common/core/range';
import { ISelection } from 'vs/editor/common/core/selection';
import { ITextModelService } from 'vs/editor/common/services/resolverService';
import { IFileService } from 'vs/platform/files/common/files';
import { bulkEdit, IResourceEdit } from 'vs/editor/common/services/bulkEdit';
import { IModelService } from 'vs/editor/common/services/modelService';

export class MainThreadEditors implements MainThreadEditorsShape {

	private _proxy: ExtHostEditorsShape;
	private _documentsAndEditors: MainThreadDocumentsAndEditors;
	private _workbenchEditorService: IWorkbenchEditorService;
	private _telemetryService: ITelemetryService;
	private _toDispose: IDisposable[];
	private _textEditorsListenersMap: { [editorId: string]: IDisposable[]; };
	private _editorPositionData: ITextEditorPositionData;
	private _registeredDecorationTypes: { [decorationType: string]: boolean; };

	constructor(
		documentsAndEditors: MainThreadDocumentsAndEditors,
		extHostContext: IExtHostContext,
		@ICodeEditorService private _codeEditorService: ICodeEditorService,
		@IWorkbenchEditorService workbenchEditorService: IWorkbenchEditorService,
		@IEditorGroupService editorGroupService: IEditorGroupService,
		@ITelemetryService telemetryService: ITelemetryService,
		@ITextModelService private readonly _textModelResolverService: ITextModelService,
		@IFileService private readonly _fileService: IFileService,
		@IModelService private readonly _modelService: IModelService,
	) {
		this._proxy = extHostContext.get(ExtHostContext.ExtHostEditors);
		this._documentsAndEditors = documentsAndEditors;
		this._workbenchEditorService = workbenchEditorService;
		this._telemetryService = telemetryService;
		this._toDispose = [];
		this._textEditorsListenersMap = Object.create(null);
		this._editorPositionData = null;

		this._toDispose.push(documentsAndEditors.onTextEditorAdd(editors => editors.forEach(this._onTextEditorAdd, this)));
		this._toDispose.push(documentsAndEditors.onTextEditorRemove(editors => editors.forEach(this._onTextEditorRemove, this)));

		this._toDispose.push(editorGroupService.onEditorsChanged(() => this._updateActiveAndVisibleTextEditors()));
		this._toDispose.push(editorGroupService.onEditorGroupMoved(() => this._updateActiveAndVisibleTextEditors()));

		this._registeredDecorationTypes = Object.create(null);
	}

	public dispose(): void {
		Object.keys(this._textEditorsListenersMap).forEach((editorId) => {
			dispose(this._textEditorsListenersMap[editorId]);
		});
		this._textEditorsListenersMap = Object.create(null);
		this._toDispose = dispose(this._toDispose);
		for (let decorationType in this._registeredDecorationTypes) {
			this._codeEditorService.removeDecorationType(decorationType);
		}
		this._registeredDecorationTypes = Object.create(null);
	}

	private _onTextEditorAdd(textEditor: MainThreadTextEditor): void {
		let id = textEditor.getId();
		let toDispose: IDisposable[] = [];
		toDispose.push(textEditor.onConfigurationChanged((opts) => {
			this._proxy.$acceptOptionsChanged(id, opts);
		}));
		toDispose.push(textEditor.onSelectionChanged((event) => {
			this._proxy.$acceptSelectionsChanged(id, event);
		}));

		this._textEditorsListenersMap[id] = toDispose;
	}

	private _onTextEditorRemove(id: string): void {
		dispose(this._textEditorsListenersMap[id]);
		delete this._textEditorsListenersMap[id];
	}

	private _updateActiveAndVisibleTextEditors(): void {

		// editor columns
		let editorPositionData = this._getTextEditorPositionData();
		if (!objectEquals(this._editorPositionData, editorPositionData)) {
			this._editorPositionData = editorPositionData;
			this._proxy.$acceptEditorPositionData(this._editorPositionData);
		}
	}

	private _getTextEditorPositionData(): ITextEditorPositionData {
		let result: ITextEditorPositionData = Object.create(null);
		for (let workbenchEditor of this._workbenchEditorService.getVisibleEditors()) {
			const id = this._documentsAndEditors.findTextEditorIdFor(workbenchEditor);
			if (id) {
				result[id] = workbenchEditor.position;
			}
		}
		return result;
	}

	// --- from extension host process

	$tryShowTextDocument(resource: URI, options: ITextDocumentShowOptions): TPromise<string> {
		const editorOptions: ITextEditorOptions = {
			preserveFocus: options.preserveFocus,
			pinned: options.pinned,
			selection: options.selection
		};

		const input = {
			resource,
			options: editorOptions
		};

		return this._workbenchEditorService.openEditor(input, options.position).then(editor => {
			if (!editor) {
				return undefined;
			}
			return this._documentsAndEditors.findTextEditorIdFor(editor);
		});
	}

	$tryShowEditor(id: string, position: EditorPosition): TPromise<void> {
		// check how often this is used
		/* __GDPR__
			"api.deprecated" : {
				"function" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		this._telemetryService.publicLog('api.deprecated', { function: 'TextEditor.show' });

		let mainThreadEditor = this._documentsAndEditors.getEditor(id);
		if (mainThreadEditor) {
			let model = mainThreadEditor.getModel();
			return this._workbenchEditorService.openEditor({
				resource: model.uri,
				options: { preserveFocus: false }
			}, position).then(() => { return; });
		}
		return undefined;
	}

	$tryHideEditor(id: string): TPromise<void> {
		// check how often this is used
		/* __GDPR__
			"api.deprecated" : {
				"function" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		this._telemetryService.publicLog('api.deprecated', { function: 'TextEditor.hide' });

		let mainThreadEditor = this._documentsAndEditors.getEditor(id);
		if (mainThreadEditor) {
			let editors = this._workbenchEditorService.getVisibleEditors();
			for (let editor of editors) {
				if (mainThreadEditor.matches(editor)) {
					return this._workbenchEditorService.closeEditor(editor.position, editor.input).then(() => { return; });
				}
			}
		}
		return undefined;
	}

	$trySetSelections(id: string, selections: ISelection[]): TPromise<any> {
		if (!this._documentsAndEditors.getEditor(id)) {
			return TPromise.wrapError(disposed(`TextEditor(${id})`));
		}
		this._documentsAndEditors.getEditor(id).setSelections(selections);
		return TPromise.as(null);
	}

	$trySetDecorations(id: string, key: string, ranges: IDecorationOptions[]): TPromise<any> {
		if (!this._documentsAndEditors.getEditor(id)) {
			return TPromise.wrapError(disposed(`TextEditor(${id})`));
		}
		this._documentsAndEditors.getEditor(id).setDecorations(key, ranges);
		return TPromise.as(null);
	}

	$trySetDecorationsFast(id: string, key: string, ranges: string): TPromise<any> {
		if (!this._documentsAndEditors.getEditor(id)) {
			return TPromise.wrapError(disposed(`TextEditor(${id})`));
		}
		this._documentsAndEditors.getEditor(id).setDecorationsFast(key, /*TODO: marshaller is too slow*/JSON.parse(ranges));
		return TPromise.as(null);
	}

	$tryRevealRange(id: string, range: IRange, revealType: TextEditorRevealType): TPromise<any> {
		if (!this._documentsAndEditors.getEditor(id)) {
			return TPromise.wrapError(disposed(`TextEditor(${id})`));
		}
		this._documentsAndEditors.getEditor(id).revealRange(range, revealType);
		return undefined;
	}

	$trySetOptions(id: string, options: ITextEditorConfigurationUpdate): TPromise<any> {
		if (!this._documentsAndEditors.getEditor(id)) {
			return TPromise.wrapError(disposed(`TextEditor(${id})`));
		}
		this._documentsAndEditors.getEditor(id).setConfiguration(options);
		return TPromise.as(null);
	}

	$tryApplyEdits(id: string, modelVersionId: number, edits: ISingleEditOperation[], opts: IApplyEditsOptions): TPromise<boolean> {
		if (!this._documentsAndEditors.getEditor(id)) {
			return TPromise.wrapError<boolean>(disposed(`TextEditor(${id})`));
		}
		return TPromise.as(this._documentsAndEditors.getEditor(id).applyEdits(modelVersionId, edits, opts));
	}

	$tryApplyWorkspaceEdit(workspaceResourceEdits: IWorkspaceResourceEdit[]): TPromise<boolean> {

		// First check if loaded models were not changed in the meantime
		for (let i = 0, len = workspaceResourceEdits.length; i < len; i++) {
			const workspaceResourceEdit = workspaceResourceEdits[i];
			if (workspaceResourceEdit.modelVersionId) {
				let model = this._modelService.getModel(workspaceResourceEdit.resource);
				if (model && model.getVersionId() !== workspaceResourceEdit.modelVersionId) {
					// model changed in the meantime
					return TPromise.as(false);
				}
			}
		}

		// Convert to shape expected by bulkEdit below
		let resourceEdits: IResourceEdit[] = [];
		for (let i = 0, len = workspaceResourceEdits.length; i < len; i++) {
			const workspaceResourceEdit = workspaceResourceEdits[i];
			const uri = workspaceResourceEdit.resource;
			const edits = workspaceResourceEdit.edits;

			for (let j = 0, lenJ = edits.length; j < lenJ; j++) {
				const edit = edits[j];

				resourceEdits.push({
					resource: uri,
					newText: edit.newText,
					newEol: edit.newEol,
					range: edit.range
				});
			}
		}

		let codeEditor: ICommonCodeEditor;
		let editor = this._workbenchEditorService.getActiveEditor();
		if (editor) {
			let candidate = editor.getControl();
			if (isCommonCodeEditor(candidate)) {
				codeEditor = candidate;
			}
		}

		return bulkEdit(this._textModelResolverService, codeEditor, resourceEdits, this._fileService)
			.then(() => true);
	}

	$tryInsertSnippet(id: string, template: string, ranges: IRange[], opts: IUndoStopOptions): TPromise<boolean> {
		if (!this._documentsAndEditors.getEditor(id)) {
			return TPromise.wrapError<boolean>(disposed(`TextEditor(${id})`));
		}
		return TPromise.as(this._documentsAndEditors.getEditor(id).insertSnippet(template, ranges, opts));
	}

	$registerTextEditorDecorationType(key: string, options: IDecorationRenderOptions): void {
		this._registeredDecorationTypes[key] = true;
		this._codeEditorService.registerDecorationType(key, options);
	}

	$removeTextEditorDecorationType(key: string): void {
		delete this._registeredDecorationTypes[key];
		this._codeEditorService.removeDecorationType(key);
	}

	$getDiffInformation(id: string): TPromise<ILineChange[]> {
		const editor = this._documentsAndEditors.getEditor(id);

		if (!editor) {
			return TPromise.wrapError<ILineChange[]>(new Error('No such TextEditor'));
		}

		const codeEditor = editor.getCodeEditor();
		const codeEditorId = codeEditor.getId();
		const diffEditors = this._codeEditorService.listDiffEditors();
		const [diffEditor] = diffEditors.filter(d => d.getOriginalEditor().getId() === codeEditorId || d.getModifiedEditor().getId() === codeEditorId);

		if (!diffEditor) {
			return TPromise.as([]);
		}

		return TPromise.as(diffEditor.getLineChanges());
	}
}
