/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as azdata from 'azdata';
import { BdcStatusModel, ResourceStatusModel } from '../controller/apiGenerated';
import { BdcDashboardResourceStatusPage } from './bdcDashboardResourceStatusPage';
import { BdcDashboardModel } from './bdcDashboardModel';
import { getHealthStatusDot } from '../utils';
import { cssStyles } from '../constants';
import { BdcDashboardPage } from './bdcDashboardPage';

type ServiceTab = { div: azdata.DivContainer, dot: azdata.TextComponent, text: azdata.TextComponent };

export class BdcServiceStatusPage extends BdcDashboardPage {

	private currentTab: { tab: ServiceTab, index: number };
	private currentTabPage: BdcDashboardResourceStatusPage;
	private rootContainer: azdata.FlexContainer;
	private resourceHeader: azdata.FlexContainer;

	private createdTabs: Map<string, ServiceTab> = new Map<string, ServiceTab>();

	constructor(private serviceName: string, private model: BdcDashboardModel, private modelView: azdata.ModelView) {
		super();
		this.model.onDidUpdateBdcStatus(bdcStatus => this.eventuallyRunOnInitialized(() => this.handleBdcStatusUpdate(bdcStatus)));
	}

	public get container(): azdata.FlexContainer {
		// Lazily create the container only when needed
		if (!this.rootContainer) {
			this.createPage();
		}
		return this.rootContainer;
	}

	private createPage(): void {
		this.rootContainer = this.modelView.modelBuilder.flexContainer().withLayout(
			{
				flexFlow: 'column',
				width: '100%',
				height: '100%'
			}).component();

		this.resourceHeader = this.modelView.modelBuilder.flexContainer().withLayout(
			{
				flexFlow: 'row',
				width: '100%',
				height: '25px'
			}
		).withProperties({
			ariaRole: 'tablist'
		}).component();

		this.rootContainer.addItem(this.resourceHeader, { CSSStyles: { 'padding-top': '15px' } });

		this.initialized = true;

		this.handleBdcStatusUpdate(this.model.bdcStatus);
	}

	private handleBdcStatusUpdate(bdcStatus: BdcStatusModel): void {
		if (!bdcStatus) {
			return;
		}
		const service = bdcStatus.services.find(s => s.serviceName === this.serviceName);
		if (service && service.resources) {
			this.createResourceNavTabs(service.resources);
		}
	}

	private changeSelectedTabPage(newPage: BdcDashboardResourceStatusPage): void {
		if (this.currentTabPage) {
			this.rootContainer.removeItem(this.currentTabPage.container);
		}
		this.rootContainer.addItem(newPage.container);
		this.currentTabPage = newPage;
	}

	/**
	 * Helper to create the navigation tabs for the resources
	 */
	private createResourceNavTabs(resources: ResourceStatusModel[]) {
		let tabIndex = this.createdTabs.size;
		resources.forEach(resource => {
			const existingTab: ServiceTab = this.createdTabs.get(resource.resourceName);
			if (existingTab) {
				// We already created this tab so just update the status
				existingTab.dot.value = getHealthStatusDot(resource.healthStatus);
			} else {
				// New tab - create and add to the end of the container
				const currentIndex = tabIndex++;
				const resourceHeaderTab = createResourceHeaderTab(this.modelView.modelBuilder, resource);
				this.createdTabs.set(resource.resourceName, resourceHeaderTab);
				const resourceStatusPage = new BdcDashboardResourceStatusPage(this.model, this.modelView, this.serviceName, resource.resourceName);
				resourceHeaderTab.div.onDidClick(() => {
					// Don't need to do anything if this is already the currently selected tab
					if (this.currentTab.index === currentIndex) {
						return;
					}
					if (this.currentTab) {
						this.currentTab.tab.text.updateCssStyles(cssStyles.unselectedResourceHeaderTab);
						this.currentTab.tab.div.ariaSelected = false;
						this.resourceHeader.removeItem(this.currentTab.tab.div);
						this.resourceHeader.insertItem(this.currentTab.tab.div, this.currentTab.index, { flex: '0 0 auto', CSSStyles: cssStyles.unselectedTabDiv });
					}
					this.changeSelectedTabPage(resourceStatusPage);
					this.currentTab = { tab: resourceHeaderTab, index: currentIndex };
					this.currentTab.tab.text.updateCssStyles(cssStyles.selectedResourceHeaderTab);
					this.currentTab.tab.div.ariaSelected = true;
					this.resourceHeader.removeItem(this.currentTab.tab.div);
					this.resourceHeader.insertItem(this.currentTab.tab.div, this.currentTab.index, { flex: '0 0 auto', CSSStyles: cssStyles.selectedTabDiv });
				});
				// Set initial page
				if (!this.currentTabPage) {
					this.changeSelectedTabPage(resourceStatusPage);
					this.currentTab = { tab: resourceHeaderTab, index: currentIndex };
					this.currentTab.tab.text.updateCssStyles(cssStyles.selectedResourceHeaderTab);
					this.currentTab.tab.div.ariaSelected = true;
					this.resourceHeader.addItem(resourceHeaderTab.div, { flex: '0 0 auto', CSSStyles: cssStyles.selectedTabDiv });
				}
				else {
					resourceHeaderTab.text.updateCssStyles(cssStyles.unselectedResourceHeaderTab);
					this.resourceHeader.addItem(resourceHeaderTab.div, { flex: '0 0 auto', CSSStyles: cssStyles.unselectedTabDiv });
				}
			}
		});
	}
}

/**
 * Creates a single resource header tab
 * @param modelBuilder The ModelBuilder used to construct the object
 * @param resourceStatus The status of the resource we're creating
 */
function createResourceHeaderTab(modelBuilder: azdata.ModelBuilder, resourceStatus: ResourceStatusModel): ServiceTab {
	const resourceHeaderTab = modelBuilder
		.divContainer()
		.withLayout({
			width: '100px',
			height: '25px'
		})
		.withProperties({
			clickable: true,
			ariaRole: 'tab'
		}).component();
	const innerContainer = modelBuilder.flexContainer().withLayout({ width: '100px', height: '25px', flexFlow: 'row' }).component();
	const statusDot = modelBuilder.text().withProperties({ value: getHealthStatusDot(resourceStatus.healthStatus), CSSStyles: { 'color': 'red', 'font-size': '40px', 'width': '20px', 'text-align': 'right', ...cssStyles.nonSelectableText } }).component();
	innerContainer.addItem(statusDot, { flex: '0 0 auto' });
	const resourceHeaderLabel = modelBuilder.text().withProperties({ value: resourceStatus.resourceName, CSSStyles: { 'text-align': 'left', ...cssStyles.tabHeaderText } }).component();
	innerContainer.addItem(resourceHeaderLabel);
	resourceHeaderTab.addItem(innerContainer);
	return { div: resourceHeaderTab, text: resourceHeaderLabel, dot: statusDot };
}
