/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from 'vs/base/browser/dom';
import * as network from 'vs/base/common/network';
import * as paths from 'vs/base/common/path';
import { CountBadge } from 'vs/base/browser/ui/countBadge/countBadge';
import { ResourceLabels, IResourceLabel } from 'vs/workbench/browser/labels';
import { HighlightedLabel } from 'vs/base/browser/ui/highlightedlabel/highlightedLabel';
import { IMarker, MarkerSeverity } from 'vs/platform/markers/common/markers';
import { ResourceMarkers, Marker, RelatedInformation } from 'vs/workbench/contrib/markers/browser/markersModel';
import Messages from 'vs/workbench/contrib/markers/browser/messages';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { attachBadgeStyler } from 'vs/platform/theme/common/styler';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IDisposable, dispose, Disposable, toDisposable } from 'vs/base/common/lifecycle';
import { ActionBar } from 'vs/base/browser/ui/actionbar/actionbar';
import { QuickFixAction, QuickFixActionViewItem } from 'vs/workbench/contrib/markers/browser/markersPanelActions';
import { ILabelService } from 'vs/platform/label/common/label';
import { dirname, basename, isEqual } from 'vs/base/common/resources';
import { IListVirtualDelegate } from 'vs/base/browser/ui/list/list';
import { ITreeFilter, TreeVisibility, TreeFilterResult, ITreeRenderer, ITreeNode, ITreeDragAndDrop, ITreeDragOverReaction } from 'vs/base/browser/ui/tree/tree';
import { FilterOptions } from 'vs/workbench/contrib/markers/browser/markersFilterOptions';
import { IMatch } from 'vs/base/common/filters';
import { Event, Emitter } from 'vs/base/common/event';
import { IAccessibilityProvider } from 'vs/base/browser/ui/list/listWidget';
import { isUndefinedOrNull } from 'vs/base/common/types';
import { URI } from 'vs/base/common/uri';
import { Action, IAction } from 'vs/base/common/actions';
import { localize } from 'vs/nls';
import { IDragAndDropData } from 'vs/base/browser/dnd';
import { ElementsDragAndDropData } from 'vs/base/browser/ui/list/listView';
import { fillResourceDataTransfers } from 'vs/workbench/browser/dnd';
import { CancelablePromise, createCancelablePromise, Delayer } from 'vs/base/common/async';
import { IModelService } from 'vs/editor/common/services/modelService';
import { Range } from 'vs/editor/common/core/range';
import { getCodeActions, CodeActionSet } from 'vs/editor/contrib/codeAction/codeAction';
import { CodeActionKind } from 'vs/editor/contrib/codeAction/codeActionTrigger';
import { ITextModel } from 'vs/editor/common/model';
import { IBulkEditService } from 'vs/editor/browser/services/bulkEditService';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IEditorService, ACTIVE_GROUP } from 'vs/workbench/services/editor/common/editorService';
import { applyCodeAction } from 'vs/editor/contrib/codeAction/codeActionCommands';
import { SeverityIcon } from 'vs/platform/severityIcon/common/severityIcon';

export type TreeElement = ResourceMarkers | Marker | RelatedInformation;

interface IResourceMarkersTemplateData {
	resourceLabel: IResourceLabel;
	count: CountBadge;
	styler: IDisposable;
}

interface IMarkerTemplateData {
	markerWidget: MarkerWidget;
}

interface IRelatedInformationTemplateData {
	resourceLabel: HighlightedLabel;
	lnCol: HTMLElement;
	description: HighlightedLabel;
}

export class MarkersTreeAccessibilityProvider implements IAccessibilityProvider<TreeElement> {

	constructor(@ILabelService private readonly labelService: ILabelService) { }

	public getAriaLabel(element: TreeElement): string | null {
		if (element instanceof ResourceMarkers) {
			const path = this.labelService.getUriLabel(element.resource, { relative: true }) || element.resource.fsPath;
			return Messages.MARKERS_TREE_ARIA_LABEL_RESOURCE(element.markers.length, element.name, paths.dirname(path));
		}
		if (element instanceof Marker) {
			return Messages.MARKERS_TREE_ARIA_LABEL_MARKER(element);
		}
		if (element instanceof RelatedInformation) {
			return Messages.MARKERS_TREE_ARIA_LABEL_RELATED_INFORMATION(element.raw);
		}
		return null;
	}
}

const enum TemplateId {
	ResourceMarkers = 'rm',
	Marker = 'm',
	RelatedInformation = 'ri'
}

export class VirtualDelegate implements IListVirtualDelegate<TreeElement> {

	static LINE_HEIGHT: number = 22;

	constructor(private readonly markersViewState: MarkersViewModel) { }

	getHeight(element: TreeElement): number {
		if (element instanceof Marker) {
			const viewModel = this.markersViewState.getViewModel(element);
			const noOfLines = !viewModel || viewModel.multiline ? element.lines.length : 1;
			return noOfLines * VirtualDelegate.LINE_HEIGHT;
		}
		return VirtualDelegate.LINE_HEIGHT;
	}

	getTemplateId(element: TreeElement): string {
		if (element instanceof ResourceMarkers) {
			return TemplateId.ResourceMarkers;
		} else if (element instanceof Marker) {
			return TemplateId.Marker;
		} else {
			return TemplateId.RelatedInformation;
		}
	}
}

const enum FilterDataType {
	ResourceMarkers,
	Marker,
	RelatedInformation
}

interface ResourceMarkersFilterData {
	type: FilterDataType.ResourceMarkers;
	uriMatches: IMatch[];
}

interface MarkerFilterData {
	type: FilterDataType.Marker;
	lineMatches: IMatch[][];
	sourceMatches: IMatch[];
	codeMatches: IMatch[];
}

interface RelatedInformationFilterData {
	type: FilterDataType.RelatedInformation;
	uriMatches: IMatch[];
	messageMatches: IMatch[];
}

export type FilterData = ResourceMarkersFilterData | MarkerFilterData | RelatedInformationFilterData;

export class ResourceMarkersRenderer implements ITreeRenderer<ResourceMarkers, ResourceMarkersFilterData, IResourceMarkersTemplateData> {

	private renderedNodes = new Map<ITreeNode<ResourceMarkers, ResourceMarkersFilterData>, IResourceMarkersTemplateData>();
	private disposables: IDisposable[] = [];

	constructor(
		private labels: ResourceLabels,
		onDidChangeRenderNodeCount: Event<ITreeNode<ResourceMarkers, ResourceMarkersFilterData>>,
		@IThemeService private readonly themeService: IThemeService,
		@ILabelService private readonly labelService: ILabelService
	) {
		onDidChangeRenderNodeCount(this.onDidChangeRenderNodeCount, this, this.disposables);
	}

	templateId = TemplateId.ResourceMarkers;

	renderTemplate(container: HTMLElement): IResourceMarkersTemplateData {
		const data = <IResourceMarkersTemplateData>Object.create(null);

		const resourceLabelContainer = dom.append(container, dom.$('.resource-label-container'));
		data.resourceLabel = this.labels.create(resourceLabelContainer, { supportHighlights: true });

		const badgeWrapper = dom.append(container, dom.$('.count-badge-wrapper'));
		data.count = new CountBadge(badgeWrapper);
		data.styler = attachBadgeStyler(data.count, this.themeService);

		return data;
	}

	renderElement(node: ITreeNode<ResourceMarkers, ResourceMarkersFilterData>, _: number, templateData: IResourceMarkersTemplateData): void {
		const resourceMarkers = node.element;
		const uriMatches = node.filterData && node.filterData.uriMatches || [];

		if (resourceMarkers.resource.scheme === network.Schemas.file || resourceMarkers.resource.scheme === network.Schemas.untitled) {
			templateData.resourceLabel.setFile(resourceMarkers.resource, { matches: uriMatches });
		} else {
			templateData.resourceLabel.setResource({ name: resourceMarkers.name, description: this.labelService.getUriLabel(dirname(resourceMarkers.resource), { relative: true }), resource: resourceMarkers.resource }, { matches: uriMatches });
		}

		this.updateCount(node, templateData);
		this.renderedNodes.set(node, templateData);
	}

	disposeElement(node: ITreeNode<ResourceMarkers, ResourceMarkersFilterData>): void {
		this.renderedNodes.delete(node);
	}

	disposeTemplate(templateData: IResourceMarkersTemplateData): void {
		templateData.resourceLabel.dispose();
		templateData.styler.dispose();
	}

	private onDidChangeRenderNodeCount(node: ITreeNode<ResourceMarkers, ResourceMarkersFilterData>): void {
		const templateData = this.renderedNodes.get(node);

		if (!templateData) {
			return;
		}

		this.updateCount(node, templateData);
	}

	private updateCount(node: ITreeNode<ResourceMarkers, ResourceMarkersFilterData>, templateData: IResourceMarkersTemplateData): void {
		templateData.count.setCount(node.children.reduce((r, n) => r + (n.visible ? 1 : 0), 0));
	}

	dispose(): void {
		this.disposables = dispose(this.disposables);
	}
}

export class FileResourceMarkersRenderer extends ResourceMarkersRenderer {
}

export class MarkerRenderer implements ITreeRenderer<Marker, MarkerFilterData, IMarkerTemplateData> {

	constructor(
		private readonly markersViewState: MarkersViewModel,
		@IInstantiationService protected instantiationService: IInstantiationService
	) { }

	templateId = TemplateId.Marker;

	renderTemplate(container: HTMLElement): IMarkerTemplateData {
		const data: IMarkerTemplateData = Object.create(null);
		data.markerWidget = new MarkerWidget(container, this.markersViewState, this.instantiationService);
		return data;
	}

	renderElement(node: ITreeNode<Marker, MarkerFilterData>, _: number, templateData: IMarkerTemplateData): void {
		templateData.markerWidget.render(node.element, node.filterData);
	}

	disposeTemplate(templateData: IMarkerTemplateData): void {
		templateData.markerWidget.dispose();
	}

}

class MarkerWidget extends Disposable {

	private readonly actionBar: ActionBar;
	private readonly icon: HTMLElement;
	private readonly multilineActionbar: ActionBar;
	private readonly messageAndDetailsContainer: HTMLElement;
	private disposables: IDisposable[] = [];

	constructor(
		private parent: HTMLElement,
		private readonly markersViewModel: MarkersViewModel,
		instantiationService: IInstantiationService
	) {
		super();
		this.actionBar = this._register(new ActionBar(dom.append(parent, dom.$('.actions')), {
			actionViewItemProvider: (action) => action.id === QuickFixAction.ID ? instantiationService.createInstance(QuickFixActionViewItem, action) : undefined
		}));
		this.icon = dom.append(parent, dom.$(''));
		this.multilineActionbar = this._register(new ActionBar(dom.append(parent, dom.$('.multiline-actions'))));
		this.messageAndDetailsContainer = dom.append(parent, dom.$('.marker-message-details'));
		this._register(toDisposable(() => this.disposables = dispose(this.disposables)));
	}

	render(element: Marker, filterData: MarkerFilterData | undefined): void {
		this.actionBar.clear();
		this.multilineActionbar.clear();
		if (this.disposables.length) {
			this.disposables = dispose(this.disposables);
		}
		dom.clearNode(this.messageAndDetailsContainer);

		this.icon.className = `marker-icon ${SeverityIcon.className(MarkerSeverity.toSeverity(element.marker.severity))}`;
		this.renderQuickfixActionbar(element);
		this.renderMultilineActionbar(element);

		this.renderMessageAndDetails(element, filterData);
		this.disposables.push(dom.addDisposableListener(this.parent, dom.EventType.MOUSE_OVER, () => this.markersViewModel.onMarkerMouseHover(element)));
		this.disposables.push(dom.addDisposableListener(this.parent, dom.EventType.MOUSE_LEAVE, () => this.markersViewModel.onMarkerMouseLeave(element)));
	}

	private renderQuickfixActionbar(marker: Marker): void {
		const viewModel = this.markersViewModel.getViewModel(marker);
		if (viewModel) {
			const quickFixAction = viewModel.quickFixAction;
			this.actionBar.push([quickFixAction], { icon: true, label: false });
			dom.toggleClass(this.icon, 'quickFix', quickFixAction.enabled);
			quickFixAction.onDidChange(({ enabled }) => {
				if (!isUndefinedOrNull(enabled)) {
					dom.toggleClass(this.icon, 'quickFix', enabled);
				}
			}, this, this.disposables);
			quickFixAction.onShowQuickFixes(() => {
				const quickFixActionViewItem = <QuickFixActionViewItem>this.actionBar.viewItems[0];
				if (quickFixActionViewItem) {
					quickFixActionViewItem.showQuickFixes();
				}
			}, this, this.disposables);
		}
	}

	private renderMultilineActionbar(marker: Marker): void {
		const viewModel = this.markersViewModel.getViewModel(marker);
		const multiline = viewModel && viewModel.multiline;
		const action = new Action('problems.action.toggleMultiline');
		action.enabled = !!viewModel && marker.lines.length > 1;
		action.tooltip = multiline ? localize('single line', "Show message in single line") : localize('multi line', "Show message in multiple lines");
		action.class = multiline ? 'octicon octicon-chevron-up' : 'octicon octicon-chevron-down';
		action.run = () => { if (viewModel) { viewModel.multiline = !viewModel.multiline; } return Promise.resolve(); };
		this.multilineActionbar.push([action], { icon: true, label: false });
	}

	private renderMessageAndDetails(element: Marker, filterData: MarkerFilterData | undefined) {
		const { marker, lines } = element;
		const viewState = this.markersViewModel.getViewModel(element);
		const multiline = !viewState || viewState.multiline;
		const lineMatches = filterData && filterData.lineMatches || [];
		const messageContainer = dom.append(this.messageAndDetailsContainer, dom.$('.marker-message'));
		dom.toggleClass(messageContainer, 'multiline', multiline);

		let lastLineElement = messageContainer;
		for (let index = 0; index < (multiline ? lines.length : 1); index++) {
			lastLineElement = dom.append(messageContainer, dom.$('.marker-message-line'));
			const highlightedLabel = new HighlightedLabel(lastLineElement, false);
			highlightedLabel.set(lines[index], lineMatches[index]);
			if (lines[index] === '') {
				lastLineElement.style.height = `${VirtualDelegate.LINE_HEIGHT}px`;
			}
		}
		this.renderDetails(marker, filterData, multiline ? lastLineElement : this.messageAndDetailsContainer);
	}

	private renderDetails(marker: IMarker, filterData: MarkerFilterData | undefined, parent: HTMLElement): void {
		dom.addClass(parent, 'details-container');
		const sourceMatches = filterData && filterData.sourceMatches || [];
		const codeMatches = filterData && filterData.codeMatches || [];

		const source = new HighlightedLabel(dom.append(parent, dom.$('')), false);
		source.set(marker.source, sourceMatches);
		dom.toggleClass(source.element, 'marker-source', !!marker.source);

		const code = new HighlightedLabel(dom.append(parent, dom.$('')), false);
		code.set(marker.code, codeMatches);
		dom.toggleClass(code.element, 'marker-code', !!marker.code);

		const lnCol = dom.append(parent, dom.$('span.marker-line'));
		lnCol.textContent = Messages.MARKERS_PANEL_AT_LINE_COL_NUMBER(marker.startLineNumber, marker.startColumn);
	}
}

export class RelatedInformationRenderer implements ITreeRenderer<RelatedInformation, RelatedInformationFilterData, IRelatedInformationTemplateData> {

	constructor(
		@ILabelService private readonly labelService: ILabelService
	) { }

	templateId = TemplateId.RelatedInformation;

	renderTemplate(container: HTMLElement): IRelatedInformationTemplateData {
		const data: IRelatedInformationTemplateData = Object.create(null);

		dom.append(container, dom.$('.actions'));
		dom.append(container, dom.$('.icon'));

		data.resourceLabel = new HighlightedLabel(dom.append(container, dom.$('.related-info-resource')), false);
		data.lnCol = dom.append(container, dom.$('span.marker-line'));

		const separator = dom.append(container, dom.$('span.related-info-resource-separator'));
		separator.textContent = ':';
		separator.style.paddingRight = '4px';

		data.description = new HighlightedLabel(dom.append(container, dom.$('.marker-description')), false);
		return data;
	}

	renderElement(node: ITreeNode<RelatedInformation, RelatedInformationFilterData>, _: number, templateData: IRelatedInformationTemplateData): void {
		const relatedInformation = node.element.raw;
		const uriMatches = node.filterData && node.filterData.uriMatches || [];
		const messageMatches = node.filterData && node.filterData.messageMatches || [];

		templateData.resourceLabel.set(basename(relatedInformation.resource), uriMatches);
		templateData.resourceLabel.element.title = this.labelService.getUriLabel(relatedInformation.resource, { relative: true });
		templateData.lnCol.textContent = Messages.MARKERS_PANEL_AT_LINE_COL_NUMBER(relatedInformation.startLineNumber, relatedInformation.startColumn);
		templateData.description.set(relatedInformation.message, messageMatches);
		templateData.description.element.title = relatedInformation.message;
	}

	disposeTemplate(templateData: IRelatedInformationTemplateData): void {
		// noop
	}
}

export class Filter implements ITreeFilter<TreeElement, FilterData> {

	constructor(public options: FilterOptions) { }

	filter(element: TreeElement, parentVisibility: TreeVisibility): TreeFilterResult<FilterData> {
		if (element instanceof ResourceMarkers) {
			return this.filterResourceMarkers(element);
		} else if (element instanceof Marker) {
			return this.filterMarker(element, parentVisibility);
		} else {
			return this.filterRelatedInformation(element, parentVisibility);
		}
	}

	private filterResourceMarkers(resourceMarkers: ResourceMarkers): TreeFilterResult<FilterData> {
		if (resourceMarkers.resource.scheme === network.Schemas.walkThrough || resourceMarkers.resource.scheme === network.Schemas.walkThroughSnippet) {
			return false;
		}

		if (this.options.excludesMatcher.matches(resourceMarkers.resource)) {
			return false;
		}

		const uriMatches = FilterOptions._filter(this.options.textFilter, basename(resourceMarkers.resource));

		if (this.options.textFilter && uriMatches) {
			return { visibility: true, data: { type: FilterDataType.ResourceMarkers, uriMatches } };
		}

		if (this.options.includesMatcher.matches(resourceMarkers.resource)) {
			return true;
		}

		return TreeVisibility.Recurse;
	}

	private filterMarker(marker: Marker, parentVisibility: TreeVisibility): TreeFilterResult<FilterData> {
		if (this.options.filterErrors && MarkerSeverity.Error === marker.marker.severity) {
			return true;
		}

		if (this.options.filterWarnings && MarkerSeverity.Warning === marker.marker.severity) {
			return true;
		}

		if (this.options.filterInfos && MarkerSeverity.Info === marker.marker.severity) {
			return true;
		}

		if (!this.options.textFilter) {
			return true;
		}

		const lineMatches: IMatch[][] = [];
		for (const line of marker.lines) {
			lineMatches.push(FilterOptions._messageFilter(this.options.textFilter, line) || []);
		}
		const sourceMatches = marker.marker.source && FilterOptions._filter(this.options.textFilter, marker.marker.source);
		const codeMatches = marker.marker.code && FilterOptions._filter(this.options.textFilter, marker.marker.code);

		if (sourceMatches || codeMatches || lineMatches.some(lineMatch => lineMatch.length > 0)) {
			return { visibility: true, data: { type: FilterDataType.Marker, lineMatches, sourceMatches: sourceMatches || [], codeMatches: codeMatches || [] } };
		}

		return parentVisibility;
	}

	private filterRelatedInformation(relatedInformation: RelatedInformation, parentVisibility: TreeVisibility): TreeFilterResult<FilterData> {
		if (!this.options.textFilter) {
			return true;
		}

		const uriMatches = FilterOptions._filter(this.options.textFilter, basename(relatedInformation.raw.resource));
		const messageMatches = FilterOptions._messageFilter(this.options.textFilter, paths.basename(relatedInformation.raw.message));

		if (uriMatches || messageMatches) {
			return { visibility: true, data: { type: FilterDataType.RelatedInformation, uriMatches: uriMatches || [], messageMatches: messageMatches || [] } };
		}

		return parentVisibility;
	}
}

export class MarkerViewModel extends Disposable {

	private readonly _onDidChange: Emitter<void> = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private modelPromise: CancelablePromise<ITextModel> | null = null;
	private codeActionsPromise: CancelablePromise<CodeActionSet> | null = null;

	constructor(
		private readonly marker: Marker,
		@IModelService private modelService: IModelService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IBulkEditService private readonly bulkEditService: IBulkEditService,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService
	) {
		super();
		this._register(toDisposable(() => {
			if (this.modelPromise) {
				this.modelPromise.cancel();
			}
			if (this.codeActionsPromise) {
				this.codeActionsPromise.cancel();
			}
		}));
	}

	private _multiline: boolean = true;
	get multiline(): boolean {
		return this._multiline;
	}

	set multiline(value: boolean) {
		if (this._multiline !== value) {
			this._multiline = value;
			this._onDidChange.fire();
		}
	}

	private _quickFixAction: QuickFixAction;
	get quickFixAction(): QuickFixAction {
		if (!this._quickFixAction) {
			this._quickFixAction = this._register(this.instantiationService.createInstance(QuickFixAction, this.marker));
		}
		return this._quickFixAction;
	}

	showLightBulb(): void {
		this.setQuickFixes(true);
	}

	showQuickfixes(): void {
		this.setQuickFixes(false).then(() => this.quickFixAction.run());
	}

	async getQuickFixes(waitForModel: boolean): Promise<IAction[]> {
		const codeActions = await this.getCodeActions(waitForModel);
		return codeActions ? this.toActions(codeActions) : [];
	}

	private async setQuickFixes(waitForModel: boolean): Promise<void> {
		const codeActions = await this.getCodeActions(waitForModel);
		this.quickFixAction.quickFixes = codeActions ? this.toActions(codeActions) : [];
		this.quickFixAction.autoFixable(!!codeActions && codeActions.hasAutoFix);
	}

	private getCodeActions(waitForModel: boolean): Promise<CodeActionSet | null> {
		if (this.codeActionsPromise !== null) {
			return this.codeActionsPromise;
		}
		return this.getModel(waitForModel)
			.then<CodeActionSet | null>(model => {
				if (model) {
					if (!this.codeActionsPromise) {
						this.codeActionsPromise = createCancelablePromise(cancellationToken => {
							return getCodeActions(model, new Range(this.marker.range.startLineNumber, this.marker.range.startColumn, this.marker.range.endLineNumber, this.marker.range.endColumn), { type: 'manual', filter: { kind: CodeActionKind.QuickFix } }, cancellationToken);
						});
					}
					return this.codeActionsPromise;
				}
				return null;
			});
	}

	private toActions(codeActions: CodeActionSet): IAction[] {
		return codeActions.actions.map(codeAction => new Action(
			codeAction.command ? codeAction.command.id : codeAction.title,
			codeAction.title,
			undefined,
			true,
			() => {
				return this.openFileAtMarker(this.marker)
					.then(() => applyCodeAction(codeAction, this.bulkEditService, this.commandService));
			}));
	}

	private openFileAtMarker(element: Marker): Promise<void> {
		const { resource, selection } = { resource: element.resource, selection: element.range };
		return this.editorService.openEditor({
			resource,
			options: {
				selection,
				preserveFocus: true,
				pinned: false,
				revealIfVisible: true
			},
		}, ACTIVE_GROUP).then(() => undefined);
	}

	private getModel(waitForModel: boolean): Promise<ITextModel | null> {
		const model = this.modelService.getModel(this.marker.resource);
		if (model) {
			return Promise.resolve(model);
		}
		if (waitForModel) {
			if (!this.modelPromise) {
				this.modelPromise = createCancelablePromise(cancellationToken => {
					return new Promise((c) => {
						this._register(this.modelService.onModelAdded(model => {
							if (isEqual(model.uri, this.marker.resource)) {
								c(model);
							}
						}));
					});
				});
			}
			return this.modelPromise;
		}
		return Promise.resolve(null);
	}

}

export class MarkersViewModel extends Disposable {

	private readonly _onDidChange: Emitter<Marker | undefined> = this._register(new Emitter<Marker | undefined>());
	readonly onDidChange: Event<Marker | undefined> = this._onDidChange.event;

	private readonly markersViewStates: Map<string, { viewModel: MarkerViewModel, disposables: IDisposable[] }> = new Map<string, { viewModel: MarkerViewModel, disposables: IDisposable[] }>();
	private readonly markersPerResource: Map<string, Marker[]> = new Map<string, Marker[]>();

	private bulkUpdate: boolean = false;

	private hoveredMarker: Marker | null;
	private hoverDelayer: Delayer<void> = new Delayer<void>(300);

	constructor(
		multiline: boolean = true,
		@IInstantiationService private instantiationService: IInstantiationService
	) {
		super();
		this._multiline = multiline;
	}

	add(marker: Marker): void {
		if (!this.markersViewStates.has(marker.hash)) {
			const viewModel = this.instantiationService.createInstance(MarkerViewModel, marker);
			const disposables: IDisposable[] = [viewModel];
			viewModel.multiline = this.multiline;
			viewModel.onDidChange(() => {
				if (!this.bulkUpdate) {
					this._onDidChange.fire(marker);
				}
			}, this, disposables);
			this.markersViewStates.set(marker.hash, { viewModel, disposables });

			const markers = this.markersPerResource.get(marker.resource.toString()) || [];
			markers.push(marker);
			this.markersPerResource.set(marker.resource.toString(), markers);
		}
	}

	remove(resource: URI): void {
		const markers = this.markersPerResource.get(resource.toString()) || [];
		for (const marker of markers) {
			const value = this.markersViewStates.get(marker.hash);
			if (value) {
				dispose(value.disposables);
			}
			this.markersViewStates.delete(marker.hash);
			if (this.hoveredMarker === marker) {
				this.hoveredMarker = null;
			}
		}
		this.markersPerResource.delete(resource.toString());
	}

	getViewModel(marker: Marker): MarkerViewModel | null {
		const value = this.markersViewStates.get(marker.hash);
		return value ? value.viewModel : null;
	}

	onMarkerMouseHover(marker: Marker): void {
		this.hoveredMarker = marker;
		this.hoverDelayer.trigger(() => {
			if (this.hoveredMarker) {
				const model = this.getViewModel(this.hoveredMarker);
				if (model) {
					model.showLightBulb();
				}
			}
		});
	}

	onMarkerMouseLeave(marker: Marker): void {
		if (this.hoveredMarker === marker) {
			this.hoveredMarker = null;
		}
	}

	private _multiline: boolean = true;
	get multiline(): boolean {
		return this._multiline;
	}

	set multiline(value: boolean) {
		let changed = false;
		if (this._multiline !== value) {
			this._multiline = value;
			changed = true;
		}
		this.bulkUpdate = true;
		this.markersViewStates.forEach(({ viewModel }) => {
			if (viewModel.multiline !== value) {
				viewModel.multiline = value;
				changed = true;
			}
		});
		this.bulkUpdate = false;
		if (changed) {
			this._onDidChange.fire(undefined);
		}
	}

	dispose(): void {
		this.markersViewStates.forEach(({ disposables }) => dispose(disposables));
		this.markersViewStates.clear();
		this.markersPerResource.clear();
		super.dispose();
	}

}

export class ResourceDragAndDrop implements ITreeDragAndDrop<TreeElement> {
	constructor(
		private instantiationService: IInstantiationService
	) { }

	onDragOver(data: IDragAndDropData, targetElement: TreeElement, targetIndex: number, originalEvent: DragEvent): boolean | ITreeDragOverReaction {
		return false;
	}

	getDragURI(element: TreeElement): string | null {
		if (element instanceof ResourceMarkers) {
			return element.resource.toString();
		}
		return null;
	}

	getDragLabel?(elements: TreeElement[]): string | undefined {
		if (elements.length > 1) {
			return String(elements.length);
		}
		const element = elements[0];
		return element instanceof ResourceMarkers ? basename(element.resource) : undefined;
	}

	onDragStart(data: IDragAndDropData, originalEvent: DragEvent): void {
		const elements = (data as ElementsDragAndDropData<TreeElement>).elements;
		const resources: URI[] = elements
			.filter(e => e instanceof ResourceMarkers)
			.map((resourceMarker: ResourceMarkers) => resourceMarker.resource);

		if (resources.length) {
			// Apply some datatransfer types to allow for dragging the element outside of the application
			this.instantiationService.invokeFunction(fillResourceDataTransfers, resources, originalEvent);
		}
	}

	drop(data: IDragAndDropData, targetElement: TreeElement, targetIndex: number, originalEvent: DragEvent): void {
	}
}
