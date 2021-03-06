/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/timelinePane';
import { localize } from 'vs/nls';
import * as DOM from 'vs/base/browser/dom';
import { CancellationTokenSource } from 'vs/base/common/cancellation';
import { FuzzyScore, createMatches } from 'vs/base/common/filters';
import { Iterator } from 'vs/base/common/iterator';
import { DisposableStore, IDisposable, Disposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import { IconLabel } from 'vs/base/browser/ui/iconLabel/iconLabel';
import { IListVirtualDelegate, IIdentityProvider, IKeyboardNavigationLabelProvider } from 'vs/base/browser/ui/list/list';
import { ITreeNode, ITreeRenderer, ITreeContextMenuEvent } from 'vs/base/browser/ui/tree/tree';
import { ViewPane, IViewPaneOptions } from 'vs/workbench/browser/parts/views/viewPaneContainer';
import { TreeResourceNavigator, WorkbenchObjectTree } from 'vs/platform/list/browser/listService';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IConfigurationService, IConfigurationChangeEvent } from 'vs/platform/configuration/common/configuration';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ITimelineService, TimelineChangeEvent, TimelineItem, TimelineOptions, TimelineProvidersChangeEvent, TimelineRequest, Timeline } from 'vs/workbench/contrib/timeline/common/timeline';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { SideBySideEditor, toResource } from 'vs/workbench/common/editor';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IThemeService, LIGHT, ThemeIcon } from 'vs/platform/theme/common/themeService';
import { IViewDescriptorService } from 'vs/workbench/common/views';
import { basename } from 'vs/base/common/path';
import { IProgressService } from 'vs/platform/progress/common/progress';
import { debounce } from 'vs/base/common/decorators';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IActionViewItemProvider, ActionBar, ActionViewItem } from 'vs/base/browser/ui/actionbar/actionbar';
import { IAction, ActionRunner } from 'vs/base/common/actions';
import { ContextAwareMenuEntryActionViewItem, createAndFillInContextMenuActions } from 'vs/platform/actions/browser/menuEntryActionViewItem';
import { MenuItemAction, IMenuService, MenuId } from 'vs/platform/actions/common/actions';
import { fromNow } from 'vs/base/common/date';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';

const InitialPageSize = 20;
const SubsequentPageSize = 40;

interface CommandItem {
	handle: 'vscode-command:loadMore';
	timestamp: number;
	label: string;
	themeIcon?: { id: string };
	description?: string;
	detail?: string;
	contextValue?: string;

	// Make things easier for duck typing
	id: undefined;
	icon: undefined;
	iconDark: undefined;
	source: undefined;
}

type TreeElement = TimelineItem | CommandItem;

// function isCommandItem(item: TreeElement | undefined): item is CommandItem {
// 	return item?.handle.startsWith('vscode-command:') ?? false;
// }

function isLoadMoreCommandItem(item: TreeElement | undefined): item is CommandItem & {
	handle: 'vscode-command:loadMore';
} {
	return item?.handle === 'vscode-command:loadMore';
}

function isTimelineItem(item: TreeElement | undefined): item is TimelineItem {
	return !item?.handle.startsWith('vscode-command:') ?? false;
}


interface TimelineActionContext {
	uri: URI | undefined;
	item: TreeElement;
}

interface TimelineCursors {
	startCursors?: { before: any; after?: any };
	endCursors?: { before: any; after?: any };
	more: boolean;
}

export class TimelinePane extends ViewPane {
	static readonly ID = 'timeline';
	static readonly TITLE = localize('timeline', 'Timeline');

	private _container!: HTMLElement;
	private _messageElement!: HTMLDivElement;
	private _treeElement!: HTMLDivElement;
	private _tree!: WorkbenchObjectTree<TreeElement, FuzzyScore>;
	private _treeRenderer: TimelineTreeRenderer | undefined;
	private _menus: TimelineMenus;
	private _visibilityDisposables: DisposableStore | undefined;

	private _excludedSources: Set<string>;
	private _cursorsByProvider: Map<string, TimelineCursors> = new Map();
	private _items: { element: TreeElement }[] = [];
	private _loadingMessageTimer: any | undefined;
	private _pendingRequests = new Map<string, TimelineRequest>();
	private _uri: URI | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService protected keybindingService: IKeybindingService,
		@IContextMenuService protected contextMenuService: IContextMenuService,
		@IContextKeyService protected contextKeyService: IContextKeyService,
		@IConfigurationService protected configurationService: IConfigurationService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IEditorService protected editorService: IEditorService,
		@ICommandService protected commandService: ICommandService,
		@IProgressService private readonly progressService: IProgressService,
		@ITimelineService protected timelineService: ITimelineService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		super({ ...options, titleMenuId: MenuId.TimelineTitle }, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService);

		this._menus = this._register(this.instantiationService.createInstance(TimelineMenus, this.id));

		const scopedContextKeyService = this._register(this.contextKeyService.createScoped());
		scopedContextKeyService.createKey('view', TimelinePane.ID);

		this._excludedSources = new Set(configurationService.getValue('timeline.excludeSources'));
		configurationService.onDidChangeConfiguration(this.onConfigurationChanged, this);
	}

	private onConfigurationChanged(e: IConfigurationChangeEvent) {
		if (!e.affectsConfiguration('timeline.excludeSources')) {
			return;
		}

		this._excludedSources = new Set(this.configurationService.getValue('timeline.excludeSources'));
		this.loadTimeline(true);
	}

	private onActiveEditorChanged() {
		let uri;

		const editor = this.editorService.activeEditor;
		if (editor) {
			uri = toResource(editor, { supportSideBySide: SideBySideEditor.MASTER });
		}

		if ((uri?.toString(true) === this._uri?.toString(true) && uri !== undefined) ||
			// Fallback to match on fsPath if we are dealing with files or git schemes
			(uri?.fsPath === this._uri?.fsPath && (uri?.scheme === 'file' || uri?.scheme === 'git') && (this._uri?.scheme === 'file' || this._uri?.scheme === 'git'))) {
			return;
		}

		this._uri = uri;
		this._treeRenderer?.setUri(uri);
		this.loadTimeline(true);
	}

	private onProvidersChanged(e: TimelineProvidersChangeEvent) {
		if (e.removed) {
			for (const source of e.removed) {
				this.replaceItems(source);
			}
		}

		if (e.added) {
			this.loadTimeline(true, e.added);
		}
	}

	private onTimelineChanged(e: TimelineChangeEvent) {
		if (e?.uri === undefined || e.uri.toString(true) !== this._uri?.toString(true)) {
			this.loadTimeline(e.reset ?? false, e?.id === undefined ? undefined : [e.id], { before: !e.reset });
		}
	}

	private onReset() {
		this.loadTimeline(true);
	}

	private _message: string | undefined;
	get message(): string | undefined {
		return this._message;
	}

	set message(message: string | undefined) {
		this._message = message;
		this.updateMessage();
	}

	private updateMessage(): void {
		if (this._message) {
			this.showMessage(this._message);
		} else {
			this.hideMessage();
		}
	}

	private showMessage(message: string): void {
		DOM.removeClass(this._messageElement, 'hide');
		this.resetMessageElement();

		this._messageElement.textContent = message;
	}

	private hideMessage(): void {
		this.resetMessageElement();
		DOM.addClass(this._messageElement, 'hide');
	}

	private resetMessageElement(): void {
		DOM.clearNode(this._messageElement);
	}

	private async loadTimeline(reset: boolean, sources?: string[], options: TimelineOptions = {}) {
		const defaultPageSize = reset ? InitialPageSize : SubsequentPageSize;

		// If we have no source, we are reseting all sources, so cancel everything in flight and reset caches
		if (sources === undefined) {
			if (reset) {
				this._items.length = 0;
				this._cursorsByProvider.clear();

				if (this._loadingMessageTimer) {
					clearTimeout(this._loadingMessageTimer);
					this._loadingMessageTimer = undefined;
				}

				for (const { tokenSource } of this._pendingRequests.values()) {
					tokenSource.dispose(true);
				}

				this._pendingRequests.clear();
			}

			// TODO[ECA]: Are these the right the list of schemes to exclude? Is there a better way?
			if (this._uri && (this._uri.scheme === 'vscode-settings' || this._uri.scheme === 'webview-panel' || this._uri.scheme === 'walkThrough')) {
				this.message = localize('timeline.editorCannotProvideTimeline', 'The active editor cannot provide timeline information.');
				this._tree.setChildren(null, undefined);

				return;
			}

			if (reset && this._uri !== undefined) {
				this._loadingMessageTimer = setTimeout((uri: URI) => {
					if (uri !== this._uri) {
						return;
					}

					this._tree.setChildren(null, undefined);
					this.message = localize('timeline.loading', 'Loading timeline for {0}...', basename(uri.fsPath));
				}, 500, this._uri);
			}
		}

		if (this._uri === undefined) {
			return;
		}

		const filteredSources = (sources ?? this.timelineService.getSources()).filter(s => !this._excludedSources.has(s));
		if (filteredSources.length === 0) {
			if (reset) {
				this.refresh();
			}

			return;
		}

		let lastIndex = this._items.length - 1;
		let lastItem = this._items[lastIndex]?.element;
		if (isLoadMoreCommandItem(lastItem)) {
			lastItem.themeIcon = { id: 'sync~spin' };
			// this._items.splice(lastIndex, 1);
			lastIndex--;

			if (!reset && !options.before) {
				lastItem = this._items[lastIndex]?.element;
				const selection = [lastItem];
				this._tree.setSelection(selection);
				this._tree.setFocus(selection);
			}
		}

		for (const source of filteredSources) {
			let request = this._pendingRequests.get(source);

			const cursors = this._cursorsByProvider.get(source);
			if (!reset) {
				// TODO: Handle pending request

				if (cursors?.more !== true) {
					continue;
				}

				const reusingToken = request?.tokenSource !== undefined;
				request = this.timelineService.getTimeline(
					source, this._uri,
					{
						cursor: options.before ? cursors?.startCursors?.before : (cursors?.endCursors ?? cursors?.startCursors)?.after,
						...options,
						limit: options.limit === 0 ? undefined : options.limit ?? defaultPageSize
					},
					request?.tokenSource ?? new CancellationTokenSource(), { cacheResults: true }
				)!;

				if (request === undefined) {
					continue;
				}

				this._pendingRequests.set(source, request);
				if (!reusingToken) {
					request.tokenSource.token.onCancellationRequested(() => this._pendingRequests.delete(source));
				}
			} else {
				request?.tokenSource.dispose(true);

				request = this.timelineService.getTimeline(
					source, this._uri,
					{
						...options,
						limit: options.limit === 0 ? undefined : (reset ? cursors?.endCursors?.after : undefined) ?? options.limit ?? defaultPageSize
					},
					new CancellationTokenSource(), { cacheResults: true }
				)!;

				if (request === undefined) {
					continue;
				}

				this._pendingRequests.set(source, request);
				request.tokenSource.token.onCancellationRequested(() => this._pendingRequests.delete(source));
			}

			this.handleRequest(request);
		}
	}

	private async handleRequest(request: TimelineRequest) {
		let timeline: Timeline | undefined;
		try {
			timeline = await this.progressService.withProgress({ location: this.getProgressLocation() }, () => request.result);
		}
		finally {
			this._pendingRequests.delete(request.source);
		}

		if (
			timeline === undefined ||
			request.tokenSource.token.isCancellationRequested ||
			request.uri !== this._uri
		) {
			return;
		}

		let items: TreeElement[];

		const source = request.source;

		if (timeline !== undefined) {
			if (timeline.paging !== undefined) {
				let cursors = this._cursorsByProvider.get(timeline.source ?? source);
				if (cursors === undefined) {
					cursors = { startCursors: timeline.paging.cursors, more: timeline.paging.more ?? false };
					this._cursorsByProvider.set(timeline.source, cursors);
				} else {
					if (request.options.before) {
						if (cursors.endCursors === undefined) {
							cursors.endCursors = cursors.startCursors;
						}
						cursors.startCursors = timeline.paging.cursors;
					}
					else {
						if (cursors.startCursors === undefined) {
							cursors.startCursors = timeline.paging.cursors;
						}
						cursors.endCursors = timeline.paging.cursors;
					}
					cursors.more = timeline.paging.more ?? true;
				}
			}
		} else {
			this._cursorsByProvider.delete(source);
		}
		items = (timeline.items as TreeElement[]) ?? [];

		const alreadyHadItems = this._items.length !== 0;

		let changed;
		if (request.options.cursor) {
			changed = this.mergeItems(request.source, items, request.options);
		} else {
			changed = this.replaceItems(request.source, items);
		}

		if (!changed) {
			// If there are no items at all and no pending requests, make sure to refresh (to show the no timeline info message)
			if (this._items.length === 0 && this._pendingRequests.size === 0) {
				this.refresh();
			}

			return;
		}

		if (this._pendingRequests.size === 0 && this._items.length !== 0) {
			const lastIndex = this._items.length - 1;
			const lastItem = this._items[lastIndex]?.element;

			if (timeline.paging?.more || Iterator.some(this._cursorsByProvider.values(), cursors => cursors.more)) {
				if (isLoadMoreCommandItem(lastItem)) {
					lastItem.themeIcon = undefined;
				}
				else {
					this._items.push({
						element: {
							handle: 'vscode-command:loadMore',
							label: localize('timeline.loadMore', 'Load more'),
							timestamp: 0
						} as CommandItem
					});
				}
			}
			else {
				if (isLoadMoreCommandItem(lastItem)) {
					this._items.splice(lastIndex, 1);
				}
			}
		}

		// If we have items already and there are other pending requests, debounce for a bit to wait for other requests
		if (alreadyHadItems && this._pendingRequests.size !== 0) {
			this.refreshDebounced();
		}
		else {
			this.refresh();
		}
	}

	private mergeItems(source: string, items: TreeElement[] | undefined, options: TimelineOptions): boolean {
		if (items?.length === undefined || items.length === 0) {
			return false;
		}

		if (options.before) {
			const ids = new Set();
			const timestamps = new Set();

			for (const item of items) {
				if (item.id === undefined) {
					timestamps.add(item.timestamp);
				}
				else {
					ids.add(item.id);
				}
			}

			// Remove any duplicate items
			// I don't think we need to check all the items, just the most recent page
			let i = Math.min(SubsequentPageSize, this._items.length);
			let item;
			while (i--) {
				item = this._items[i].element;
				if (
					(item.id === undefined && ids.has(item.id)) ||
					(item.timestamp === undefined && timestamps.has(item.timestamp))
				) {
					this._items.splice(i, 1);
				}
			}

			this._items.splice(0, 0, ...items.map(item => ({ element: item })));
		} else {
			this._items.push(...items.map(item => ({ element: item })));
		}

		this.sortItems();
		return true;
	}

	private replaceItems(source: string, items?: TreeElement[]): boolean {
		if (items?.length) {
			this._items.splice(
				0, this._items.length,
				...this._items.filter(item => item.element.source !== source),
				...items.map(item => ({ element: item }))
			);
			this.sortItems();

			return true;
		}

		if (this._items.length && this._items.some(item => item.element.source === source)) {
			this._items = this._items.filter(item => item.element.source !== source);

			return true;
		}

		return false;
	}

	private sortItems() {
		this._items.sort(
			(a, b) =>
				(b.element.timestamp - a.element.timestamp) ||
				(a.element.source === undefined
					? b.element.source === undefined ? 0 : 1
					: b.element.source === undefined ? -1 : b.element.source.localeCompare(a.element.source, undefined, { numeric: true, sensitivity: 'base' }))
		);

	}

	private refresh() {
		if (this._loadingMessageTimer) {
			clearTimeout(this._loadingMessageTimer);
			this._loadingMessageTimer = undefined;
		}

		if (this._items.length === 0) {
			this.message = localize('timeline.noTimelineInfo', 'No timeline information was provided.');
		} else {
			this.message = undefined;
		}

		this._tree.setChildren(null, this._items);
	}

	@debounce(500)
	private refreshDebounced() {
		this.refresh();
	}

	focus(): void {
		super.focus();
		this._tree.domFocus();
	}

	setVisible(visible: boolean): void {
		if (visible) {
			this._visibilityDisposables = new DisposableStore();

			this.timelineService.onDidChangeProviders(this.onProvidersChanged, this, this._visibilityDisposables);
			this.timelineService.onDidChangeTimeline(this.onTimelineChanged, this, this._visibilityDisposables);
			this.timelineService.onDidReset(this.onReset, this, this._visibilityDisposables);
			this.editorService.onDidActiveEditorChange(this.onActiveEditorChanged, this, this._visibilityDisposables);

			this.onActiveEditorChanged();
		} else {
			this._visibilityDisposables?.dispose();
		}
	}

	protected layoutBody(height: number, width: number): void {
		this._tree.layout(height, width);
	}

	protected renderBody(container: HTMLElement): void {
		this._container = container;
		DOM.addClasses(container, 'tree-explorer-viewlet-tree-view', 'timeline-tree-view');

		this._messageElement = DOM.append(this._container, DOM.$('.message'));
		DOM.addClass(this._messageElement, 'timeline-subtle');

		this.message = localize('timeline.editorCannotProvideTimeline', 'The active editor cannot provide timeline information.');

		this._treeElement = document.createElement('div');
		DOM.addClasses(this._treeElement, 'customview-tree', 'file-icon-themable-tree', 'hide-arrows');
		// DOM.addClass(this._treeElement, 'show-file-icons');
		container.appendChild(this._treeElement);

		this._treeRenderer = this.instantiationService.createInstance(TimelineTreeRenderer, this._menus);
		this._tree = <WorkbenchObjectTree<TreeElement, FuzzyScore>>this.instantiationService.createInstance(WorkbenchObjectTree, 'TimelinePane',
			this._treeElement, new TimelineListVirtualDelegate(), [this._treeRenderer], {
			identityProvider: new TimelineIdentityProvider(),
			keyboardNavigationLabelProvider: new TimelineKeyboardNavigationLabelProvider(),
			overrideStyles: {
				listBackground: this.getBackgroundColor(),

			}
		});

		const customTreeNavigator = new TreeResourceNavigator(this._tree, { openOnFocus: false, openOnSelection: false });
		this._register(customTreeNavigator);
		this._register(this._tree.onContextMenu(e => this.onContextMenu(this._menus, e)));
		this._register(
			customTreeNavigator.onDidOpenResource(e => {
				if (!e.browserEvent) {
					return;
				}

				const selection = this._tree.getSelection();
				const item = selection.length === 1 ? selection[0] : undefined;
				// eslint-disable-next-line eqeqeq
				if (item == null) {
					return;
				}

				if (isTimelineItem(item)) {
					if (item.command) {
						this.commandService.executeCommand(item.command.id, ...(item.command.arguments || []));
					}
				}
				else if (isLoadMoreCommandItem(item)) {
					// TODO: Change this, but right now this is the pending signal
					if (item.themeIcon !== undefined) {
						return;
					}

					this.loadTimeline(false);
				}
			})
		);
	}

	private onContextMenu(menus: TimelineMenus, treeEvent: ITreeContextMenuEvent<TreeElement | null>): void {
		const item = treeEvent.element;
		if (item === null) {
			return;
		}
		const event: UIEvent = treeEvent.browserEvent;

		event.preventDefault();
		event.stopPropagation();

		this._tree.setFocus([item]);
		const actions = menus.getResourceContextActions(item);
		if (!actions.length) {
			return;
		}

		this.contextMenuService.showContextMenu({
			getAnchor: () => treeEvent.anchor,
			getActions: () => actions,
			getActionViewItem: (action) => {
				const keybinding = this.keybindingService.lookupKeybinding(action.id);
				if (keybinding) {
					return new ActionViewItem(action, action, { label: true, keybinding: keybinding.getLabel() });
				}
				return undefined;
			},
			onHide: (wasCancelled?: boolean) => {
				if (wasCancelled) {
					this._tree.domFocus();
				}
			},
			getActionsContext: (): TimelineActionContext => ({ uri: this._uri, item: item }),
			actionRunner: new TimelineActionRunner()
		});
	}
}

export class TimelineElementTemplate implements IDisposable {
	static readonly id = 'TimelineElementTemplate';

	readonly actionBar: ActionBar;
	readonly icon: HTMLElement;
	readonly iconLabel: IconLabel;
	readonly timestamp: HTMLSpanElement;

	constructor(
		readonly container: HTMLElement,
		actionViewItemProvider: IActionViewItemProvider
	) {
		DOM.addClass(container, 'custom-view-tree-node-item');
		this.icon = DOM.append(container, DOM.$('.custom-view-tree-node-item-icon'));

		this.iconLabel = new IconLabel(container, { supportHighlights: true, supportCodicons: true });

		const timestampContainer = DOM.append(this.iconLabel.element, DOM.$('.timeline-timestamp-container'));
		this.timestamp = DOM.append(timestampContainer, DOM.$('span.timeline-timestamp'));

		const actionsContainer = DOM.append(this.iconLabel.element, DOM.$('.actions'));
		this.actionBar = new ActionBar(actionsContainer, { actionViewItemProvider: actionViewItemProvider });
	}

	dispose() {
		this.iconLabel.dispose();
		this.actionBar.dispose();
	}

	reset() {
		this.actionBar.clear();
	}
}

export class TimelineIdentityProvider implements IIdentityProvider<TreeElement> {
	getId(item: TreeElement): { toString(): string } {
		return item.handle;
	}
}

class TimelineActionRunner extends ActionRunner {

	runAction(action: IAction, { uri, item }: TimelineActionContext): Promise<any> {
		if (!isTimelineItem(item)) {
			// TODO
			return action.run();
		}

		return action.run(...[
			{
				$mid: 11,
				handle: item.handle,
				source: item.source,
				uri: uri
			},
			uri,
			item.source,
		]);
	}
}

export class TimelineKeyboardNavigationLabelProvider implements IKeyboardNavigationLabelProvider<TreeElement> {
	getKeyboardNavigationLabel(element: TreeElement): { toString(): string } {
		return element.label;
	}
}

export class TimelineListVirtualDelegate implements IListVirtualDelegate<TreeElement> {
	getHeight(_element: TreeElement): number {
		return 22;
	}

	getTemplateId(element: TreeElement): string {
		return TimelineElementTemplate.id;
	}
}

class TimelineTreeRenderer implements ITreeRenderer<TreeElement, FuzzyScore, TimelineElementTemplate> {
	readonly templateId: string = TimelineElementTemplate.id;

	private _actionViewItemProvider: IActionViewItemProvider;

	constructor(
		private readonly _menus: TimelineMenus,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IThemeService private _themeService: IThemeService
	) {
		this._actionViewItemProvider = (action: IAction) => action instanceof MenuItemAction
			? this.instantiationService.createInstance(ContextAwareMenuEntryActionViewItem, action)
			: undefined;
	}

	private _uri: URI | undefined;
	setUri(uri: URI | undefined) {
		this._uri = uri;
	}

	renderTemplate(container: HTMLElement): TimelineElementTemplate {
		return new TimelineElementTemplate(container, this._actionViewItemProvider);
	}

	renderElement(
		node: ITreeNode<TreeElement, FuzzyScore>,
		index: number,
		template: TimelineElementTemplate,
		height: number | undefined
	): void {
		template.reset();

		const { element: item } = node;

		const icon = this._themeService.getTheme().type === LIGHT ? item.icon : item.iconDark;
		const iconUrl = icon ? URI.revive(icon) : null;

		if (iconUrl) {
			template.icon.className = 'custom-view-tree-node-item-icon';
			template.icon.style.backgroundImage = DOM.asCSSUrl(iconUrl);
		} else {
			let iconClass: string | undefined;
			if (item.themeIcon /*&& !this.isFileKindThemeIcon(element.themeIcon)*/) {
				iconClass = ThemeIcon.asClassName(item.themeIcon);
			}
			template.icon.className = iconClass ? `custom-view-tree-node-item-icon ${iconClass}` : '';
		}

		template.iconLabel.setLabel(item.label, item.description, {
			title: item.detail,
			matches: createMatches(node.filterData)
		});

		template.timestamp.textContent = isTimelineItem(item) ? fromNow(item.timestamp) : '';

		template.actionBar.context = { uri: this._uri, item: item } as TimelineActionContext;
		template.actionBar.actionRunner = new TimelineActionRunner();
		template.actionBar.push(this._menus.getResourceActions(item), { icon: true, label: false });
	}

	disposeTemplate(template: TimelineElementTemplate): void {
		template.iconLabel.dispose();
	}
}

class TimelineMenus extends Disposable {

	constructor(
		private id: string,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IMenuService private readonly menuService: IMenuService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService
	) {
		super();
	}

	getResourceActions(element: TreeElement): IAction[] {
		return this.getActions(MenuId.TimelineItemContext, { key: 'timelineItem', value: element.contextValue }).primary;
	}

	getResourceContextActions(element: TreeElement): IAction[] {
		return this.getActions(MenuId.TimelineItemContext, { key: 'timelineItem', value: element.contextValue }).secondary;
	}

	private getActions(menuId: MenuId, context: { key: string, value?: string }): { primary: IAction[]; secondary: IAction[]; } {
		const contextKeyService = this.contextKeyService.createScoped();
		contextKeyService.createKey('view', this.id);
		contextKeyService.createKey(context.key, context.value);

		const menu = this.menuService.createMenu(menuId, contextKeyService);
		const primary: IAction[] = [];
		const secondary: IAction[] = [];
		const result = { primary, secondary };
		createAndFillInContextMenuActions(menu, { shouldForwardArgs: true }, result, this.contextMenuService, g => /^inline/.test(g));

		menu.dispose();
		contextKeyService.dispose();

		return result;
	}
}
