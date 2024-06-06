/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from 'vs/base/browser/dom';
import { KeyCode } from 'vs/base/common/keyCodes';
import { Disposable, DisposableStore, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { ICodeEditor, IEditorMouseEvent, MouseTargetType } from 'vs/editor/browser/editorBrowser';
import { EditorOption } from 'vs/editor/common/config/editorOptions';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { ModelDecorationOptions } from 'vs/editor/common/model/textModel';
import { TokenizationRegistry } from 'vs/editor/common/languages';
import { HoverOperation, HoverStartMode, HoverStartSource } from 'vs/editor/contrib/hover/browser/hoverOperation';
import { HoverAnchor, HoverParticipantRegistry, HoverRangeAnchor, IEditorHoverContext, IEditorHoverParticipant, IEditorHoverRenderContext, IHoverPart, IHoverWidget } from 'vs/editor/contrib/hover/browser/hoverTypes';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { MarkdownHoverParticipant } from 'vs/editor/contrib/hover/browser/markdownHoverParticipant';
import { InlayHintsHover } from 'vs/editor/contrib/inlayHints/browser/inlayHintsHover';
import { HoverVerbosityAction } from 'vs/editor/common/standalone/standaloneEnums';
import { ContentHoverWidget } from 'vs/editor/contrib/hover/browser/contentHoverWidget';
import { ContentHoverComputer } from 'vs/editor/contrib/hover/browser/contentHoverComputer';
import { HoverResult } from 'vs/editor/contrib/hover/browser/contentHoverTypes';
import { EditorHoverStatusBar } from 'vs/editor/contrib/hover/browser/contentHoverStatusBar';
import { Emitter } from 'vs/base/common/event';

export class ContentHoverController extends Disposable implements IHoverWidget {

	private _currentResult: HoverResult | null = null;

	private readonly _computer: ContentHoverComputer;
	private readonly _contentHoverWidget: ContentHoverWidget;
	private readonly _participants: IEditorHoverParticipant[];
	// TODO@aiday-mar make array of participants, dispatch between them
	private readonly _markdownHoverParticipant: MarkdownHoverParticipant | undefined;
	private readonly _hoverOperation: HoverOperation<IHoverPart>;

	private readonly _onContentsChanged = this._register(new Emitter<void>());
	public readonly onContentsChanged = this._onContentsChanged.event;

	constructor(
		private readonly _editor: ICodeEditor,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
	) {
		super();
		this._contentHoverWidget = this._register(this._instantiationService.createInstance(ContentHoverWidget, this._editor));
		const initializedParticipants = this._initializeHoverParticipants();
		this._participants = initializedParticipants.participants;
		this._markdownHoverParticipant = initializedParticipants.markdownHoverParticipant;
		this._computer = new ContentHoverComputer(this._editor, this._participants);
		this._hoverOperation = this._register(new HoverOperation(this._editor, this._computer));
		this._registerListeners();
	}

	private _initializeHoverParticipants(): { participants: IEditorHoverParticipant[]; markdownHoverParticipant: MarkdownHoverParticipant | undefined } {
		const participants: IEditorHoverParticipant[] = [];
		let markdownHoverParticipant: MarkdownHoverParticipant | undefined;
		for (const participant of HoverParticipantRegistry.getAll()) {
			const participantInstance = this._instantiationService.createInstance(participant, this._editor);
			if (participantInstance instanceof MarkdownHoverParticipant && !(participantInstance instanceof InlayHintsHover)) {
				markdownHoverParticipant = participantInstance;
			}
			participants.push(participantInstance);
		}
		participants.sort((p1, p2) => p1.hoverOrdinal - p2.hoverOrdinal);
		return { participants, markdownHoverParticipant };
	}

	private _registerListeners(): void {
		this._register(this._hoverOperation.onResult((result) => {
			if (!this._computer.anchor) {
				// invalid state, ignore result
				return;
			}
			const messages = (result.hasLoadingMessage ? this._addLoadingMessage(result.value) : result.value);
			this._withResult(new HoverResult(this._computer.anchor, messages, result.isComplete));
		}));
		this._register(dom.addStandardDisposableListener(this._contentHoverWidget.getDomNode(), 'keydown', (e) => {
			if (e.equals(KeyCode.Escape)) {
				this.hide();
			}
		}));
		this._register(TokenizationRegistry.onDidChange(() => {
			if (this._contentHoverWidget.position && this._currentResult) {
				this._setCurrentResult(this._currentResult); // render again
			}
		}));
	}

	/**
	 * Returns true if the hover shows now or will show.
	 */
	private _startShowingOrUpdateHover(
		anchor: HoverAnchor | null,
		mode: HoverStartMode,
		source: HoverStartSource,
		focus: boolean,
		mouseEvent: IEditorMouseEvent | null
	): boolean {
		const contentHoverIsVisible = this._contentHoverWidget.position && this._currentResult;
		if (!contentHoverIsVisible) {
			if (anchor) {
				this._startHoverOperationIfNecessary(anchor, mode, source, focus, false);
				return true;
			}
			return false;
		}
		const isHoverSticky = this._editor.getOption(EditorOption.hover).sticky;
		const isMouseGettingCloser = mouseEvent && this._contentHoverWidget.isMouseGettingCloser(mouseEvent.event.posx, mouseEvent.event.posy);
		const isHoverStickyAndIsMouseGettingCloser = isHoverSticky && isMouseGettingCloser;
		// The mouse is getting closer to the hover, so we will keep the hover untouched
		// But we will kick off a hover update at the new anchor, insisting on keeping the hover visible.
		if (isHoverStickyAndIsMouseGettingCloser) {
			if (anchor) {
				this._startHoverOperationIfNecessary(anchor, mode, source, focus, true);
			}
			return true;
		}
		// If mouse is not getting closer and anchor not defined, hide the hover
		if (!anchor) {
			this._setCurrentResult(null);
			return false;
		}
		// If mouse if not getting closer and anchor is defined, and the new anchor is the same as the previous anchor
		const currentAnchorEqualsPreviousAnchor = this._currentResult!.anchor.equals(anchor);
		if (currentAnchorEqualsPreviousAnchor) {
			return true;
		}
		// If mouse if not getting closer and anchor is defined, and the new anchor is not compatible with the previous anchor
		const currentAnchorCompatibleWithPreviousAnchor = anchor.canAdoptVisibleHover(this._currentResult!.anchor, this._contentHoverWidget.position);
		if (!currentAnchorCompatibleWithPreviousAnchor) {
			this._setCurrentResult(null);
			this._startHoverOperationIfNecessary(anchor, mode, source, focus, false);
			return true;
		}
		// We aren't getting any closer to the hover, so we will filter existing results
		// and keep those which also apply to the new anchor.
		this._setCurrentResult(this._currentResult!.filter(anchor));
		this._startHoverOperationIfNecessary(anchor, mode, source, focus, false);
		return true;
	}

	private _startHoverOperationIfNecessary(anchor: HoverAnchor, mode: HoverStartMode, source: HoverStartSource, focus: boolean, insistOnKeepingHoverVisible: boolean): void {
		const currentAnchorEqualToPreviousHover = this._computer.anchor && this._computer.anchor.equals(anchor);
		if (currentAnchorEqualToPreviousHover) {
			return;
		}
		this._hoverOperation.cancel();
		this._computer.anchor = anchor;
		this._computer.shouldFocus = focus;
		this._computer.source = source;
		this._computer.insistOnKeepingHoverVisible = insistOnKeepingHoverVisible;
		this._hoverOperation.start(mode);
	}

	private _setCurrentResult(hoverResult: HoverResult | null): void {
		let currentHoverResult = hoverResult;
		const currentResultEqualToPreviousResult = this._currentResult === currentHoverResult;
		if (currentResultEqualToPreviousResult) {
			return;
		}
		const currentHoverResultIsEmpty = currentHoverResult && currentHoverResult.hoverParts.length === 0;
		if (currentHoverResultIsEmpty) {
			currentHoverResult = null;
		}
		this._currentResult = currentHoverResult;
		if (this._currentResult) {
			this._showHover(this._currentResult);
		} else {
			this._hideHover();
		}
	}

	private _addLoadingMessage(result: IHoverPart[]): IHoverPart[] {
		if (!this._computer.anchor) {
			return result;
		}
		for (const participant of this._participants) {
			if (!participant.createLoadingMessage) {
				continue;
			}
			const loadingMessage = participant.createLoadingMessage(this._computer.anchor);
			if (!loadingMessage) {
				continue;
			}
			return result.slice(0).concat([loadingMessage]);
		}
		return result;
	}

	private _withResult(hoverResult: HoverResult): void {
		const previousHoverIsVisibleWithCompleteResult = this._contentHoverWidget.position && this._currentResult && this._currentResult.isComplete;
		if (!previousHoverIsVisibleWithCompleteResult) {
			this._setCurrentResult(hoverResult);
		}
		// The hover is visible with a previous complete result.
		const isCurrentHoverResultComplete = hoverResult.isComplete;
		if (!isCurrentHoverResultComplete) {
			// Instead of rendering the new partial result, we wait for the result to be complete.
			return;
		}
		const currentHoverResultIsEmpty = hoverResult.hoverParts.length === 0;
		const insistOnKeepingPreviousHoverVisible = this._computer.insistOnKeepingHoverVisible;
		const shouldKeepPreviousHoverVisible = currentHoverResultIsEmpty && insistOnKeepingPreviousHoverVisible;
		if (shouldKeepPreviousHoverVisible) {
			// The hover would now hide normally, so we'll keep the previous messages
			return;
		}
		this._setCurrentResult(hoverResult);
	}

	private _showHover(hoverResult: HoverResult): void {
		const hoverContext = this._getHoverContext();
		const renderedHoverData = new RenderedContentHover(
			this._editor,
			hoverContext,
			this._participants,
			hoverResult,
			this._computer,
			this._keybindingService
		);
		if (renderedHoverData.hasContent) {
			this._contentHoverWidget.showAt(renderedHoverData);
		} else {
			renderedHoverData.dispose();
		}
	}

	private _hideHover(): void {
		this._contentHoverWidget.hide();
	}

	private _getHoverContext(): IEditorHoverContext {
		const hide = () => {
			this.hide();
		};
		const onContentsChanged = () => {
			this._onContentsChanged.fire();
			this._contentHoverWidget.onContentsChanged();
		};
		const setMinimumDimensions = (dimensions: dom.Dimension) => {
			this._contentHoverWidget.setMinimumDimensions(dimensions);
		};
		return { hide, onContentsChanged, setMinimumDimensions };
	}

	public static computeHoverRanges(editor: ICodeEditor, anchorRange: Range, hoverParts: IHoverPart[]) {

		let startColumnBoundary = 1;
		if (editor.hasModel()) {
			// Ensure the range is on the current view line
			const viewModel = editor._getViewModel();
			const coordinatesConverter = viewModel.coordinatesConverter;
			const anchorViewRange = coordinatesConverter.convertModelRangeToViewRange(anchorRange);
			const anchorViewRangeStart = new Position(anchorViewRange.startLineNumber, viewModel.getLineMinColumn(anchorViewRange.startLineNumber));
			startColumnBoundary = coordinatesConverter.convertViewPositionToModelPosition(anchorViewRangeStart).column;
		}

		// The anchor range is always on a single line
		const anchorLineNumber = anchorRange.startLineNumber;
		let renderStartColumn = anchorRange.startColumn;
		let highlightRange = hoverParts[0].range;
		let forceShowAtRange = null;

		for (const hoverPart of hoverParts) {
			highlightRange = Range.plusRange(highlightRange, hoverPart.range);
			const hoverRangeIsWithinAnchorLine = hoverPart.range.startLineNumber === anchorLineNumber && hoverPart.range.endLineNumber === anchorLineNumber;
			if (hoverRangeIsWithinAnchorLine) {
				// this message has a range that is completely sitting on the line of the anchor
				renderStartColumn = Math.max(Math.min(renderStartColumn, hoverPart.range.startColumn), startColumnBoundary);
			}
			if (hoverPart.forceShowAtRange) {
				forceShowAtRange = hoverPart.range;
			}
		}

		const showAtPosition = forceShowAtRange ? forceShowAtRange.getStartPosition() : new Position(anchorLineNumber, anchorRange.startColumn);
		const showAtSecondaryPosition = forceShowAtRange ? forceShowAtRange.getStartPosition() : new Position(anchorLineNumber, renderStartColumn);

		return {
			showAtPosition,
			showAtSecondaryPosition,
			highlightRange
		};
	}

	public showsOrWillShow(mouseEvent: IEditorMouseEvent): boolean {
		const isContentWidgetResizing = this._contentHoverWidget.isResizing;
		if (isContentWidgetResizing) {
			return true;
		}
		const anchorCandidates: HoverAnchor[] = this._findHoverAnchorCandidates(mouseEvent);
		const anchorCandidatesExist = anchorCandidates.length > 0;
		if (!anchorCandidatesExist) {
			return this._startShowingOrUpdateHover(null, HoverStartMode.Delayed, HoverStartSource.Mouse, false, mouseEvent);
		}
		const anchor = anchorCandidates[0];
		return this._startShowingOrUpdateHover(anchor, HoverStartMode.Delayed, HoverStartSource.Mouse, false, mouseEvent);
	}

	private _findHoverAnchorCandidates(mouseEvent: IEditorMouseEvent): HoverAnchor[] {
		const anchorCandidates: HoverAnchor[] = [];
		for (const participant of this._participants) {
			if (!participant.suggestHoverAnchor) {
				continue;
			}
			const anchor = participant.suggestHoverAnchor(mouseEvent);
			if (!anchor) {
				continue;
			}
			anchorCandidates.push(anchor);
		}
		const target = mouseEvent.target;
		switch (target.type) {
			case MouseTargetType.CONTENT_TEXT: {
				anchorCandidates.push(new HoverRangeAnchor(0, target.range, mouseEvent.event.posx, mouseEvent.event.posy));
				break;
			}
			case MouseTargetType.CONTENT_EMPTY: {
				const epsilon = this._editor.getOption(EditorOption.fontInfo).typicalHalfwidthCharacterWidth / 2;
				// Let hover kick in even when the mouse is technically in the empty area after a line, given the distance is small enough
				const mouseIsWithinLinesAndCloseToHover = !target.detail.isAfterLines
					&& typeof target.detail.horizontalDistanceToText === 'number'
					&& target.detail.horizontalDistanceToText < epsilon;
				if (!mouseIsWithinLinesAndCloseToHover) {
					break;
				}
				anchorCandidates.push(new HoverRangeAnchor(0, target.range, mouseEvent.event.posx, mouseEvent.event.posy));
				break;
			}
		}
		anchorCandidates.sort((a, b) => b.priority - a.priority);
		return anchorCandidates;
	}

	public startShowingAtRange(range: Range, mode: HoverStartMode, source: HoverStartSource, focus: boolean): void {
		this._startShowingOrUpdateHover(new HoverRangeAnchor(0, range, undefined, undefined), mode, source, focus, null);
	}

	public async updateMarkdownHoverVerbosityLevel(action: HoverVerbosityAction, index?: number, focus?: boolean): Promise<void> {
		this._markdownHoverParticipant?.updateMarkdownHoverVerbosityLevel(action, index, focus);
	}

	public focusedMarkdownHoverIndex(): number {
		return this._markdownHoverParticipant?.focusedMarkdownHoverIndex() ?? -1;
	}

	public markdownHoverContentAtIndex(index: number): string {
		return this._markdownHoverParticipant?.markdownHoverContentAtIndex(index) ?? '';
	}

	public doesMarkdownHoverAtIndexSupportVerbosityAction(index: number, action: HoverVerbosityAction): boolean {
		return this._markdownHoverParticipant?.doesMarkdownHoverAtIndexSupportVerbosityAction(index, action) ?? false;
	}

	public getWidgetContent(): string | undefined {
		const node = this._contentHoverWidget.getDomNode();
		if (!node.textContent) {
			return undefined;
		}
		return node.textContent;
	}

	public containsNode(node: Node | null | undefined): boolean {
		return (node ? this._contentHoverWidget.getDomNode().contains(node) : false);
	}

	public focus(): void {
		this._contentHoverWidget.focus();
	}

	public scrollUp(): void {
		this._contentHoverWidget.scrollUp();
	}

	public scrollDown(): void {
		this._contentHoverWidget.scrollDown();
	}

	public scrollLeft(): void {
		this._contentHoverWidget.scrollLeft();
	}

	public scrollRight(): void {
		this._contentHoverWidget.scrollRight();
	}

	public pageUp(): void {
		this._contentHoverWidget.pageUp();
	}

	public pageDown(): void {
		this._contentHoverWidget.pageDown();
	}

	public goToTop(): void {
		this._contentHoverWidget.goToTop();
	}

	public goToBottom(): void {
		this._contentHoverWidget.goToBottom();
	}

	public hide(): void {
		this._computer.anchor = null;
		this._hoverOperation.cancel();
		this._setCurrentResult(null);
	}

	public get isColorPickerVisible(): boolean {
		return this._contentHoverWidget.isColorPickerVisible;
	}

	public get isVisibleFromKeyboard(): boolean {
		return this._contentHoverWidget.isVisibleFromKeyboard;
	}

	public get isVisible(): boolean {
		return this._contentHoverWidget.isVisible;
	}

	public get isFocused(): boolean {
		return this._contentHoverWidget.isFocused;
	}

	public get isResizing(): boolean {
		return this._contentHoverWidget.isResizing;
	}

	public get widget() {
		return this._contentHoverWidget;
	}
}

export class RenderedContentHover extends Disposable {

	private static readonly _DECORATION_OPTIONS = ModelDecorationOptions.register({
		description: 'content-hover-highlight',
		className: 'hoverHighlight'
	});

	public closestMouseDistance: number | undefined;
	public initialMousePosX: number | undefined;
	public initialMousePosY: number | undefined;
	public readonly showAtPosition: Position;
	public readonly showAtSecondaryPosition: Position;
	public readonly preferAbove: boolean;
	public readonly stoleFocus: boolean;
	public readonly source: HoverStartSource;
	public readonly isBeforeContent: boolean;

	private readonly _renderedHoverParts: RenderedHoverParts;

	constructor(
		editor: ICodeEditor,
		context: IEditorHoverContext,
		participants: IEditorHoverParticipant[],
		hoverResult: HoverResult,
		computer: ContentHoverComputer,
		keybindingService: IKeybindingService,
	) {
		super();
		const hoverParts = hoverResult.hoverParts;
		const anchor = hoverResult.anchor;
		this._renderedHoverParts = new RenderedHoverParts(hoverParts, participants, context, keybindingService);
		this._register(this._renderedHoverParts);
		const { showAtPosition, showAtSecondaryPosition, highlightRange } = ContentHoverController.computeHoverRanges(editor, anchor.range, hoverParts);
		this.showAtPosition = showAtPosition;
		this.showAtSecondaryPosition = showAtSecondaryPosition;
		this._register(this._addEditorDecorations(editor, highlightRange));
		this.initialMousePosX = anchor.initialMousePosX;
		this.initialMousePosY = anchor.initialMousePosY;
		this.preferAbove = editor.getOption(EditorOption.hover).above;
		this.stoleFocus = computer.shouldFocus;
		this.source = computer.source;
		this.isBeforeContent = hoverParts.some(m => m.isBeforeContent);
	}

	private _addEditorDecorations(editor: ICodeEditor, highlightRange: Range | undefined): IDisposable {
		if (!highlightRange) {
			return Disposable.None;
		}
		const highlightDecoration = editor.createDecorationsCollection();
		highlightDecoration.set([{
			range: highlightRange,
			options: RenderedContentHover._DECORATION_OPTIONS
		}]);
		return toDisposable(() => {
			highlightDecoration.clear();
		});
	}

	public get hasContent(): boolean {
		return this._renderedHoverParts.hasContent;
	}

	public get domNode(): DocumentFragment {
		return this._renderedHoverParts.domNode;
	}
}

class RenderedHoverParts extends Disposable {

	private readonly _participants: IEditorHoverParticipant<IHoverPart>[];
	private readonly _fragment: DocumentFragment;
	public readonly hasContent: boolean;

	constructor(
		hoverParts: IHoverPart[],
		participants: IEditorHoverParticipant<IHoverPart>[],
		context: IEditorHoverContext,
		keybindingService: IKeybindingService
	) {
		super();
		this._fragment = document.createDocumentFragment();
		this._participants = participants;
		const statusBar = new EditorHoverStatusBar(keybindingService);
		const hoverContext: IEditorHoverRenderContext = { fragment: this._fragment, statusBar, ...context };
		this._register(this._renderHoverPartsUsingContext(hoverContext, hoverParts));
		this._register(this._renderStatusBar(this._fragment, statusBar));
		this.hasContent = this._fragment.hasChildNodes();
	}

	private _renderHoverPartsUsingContext(context: IEditorHoverRenderContext, hoverParts: IHoverPart[]): IDisposable {
		const disposables = new DisposableStore();
		for (const participant of this._participants) {
			const hoverPartsForParticipant = hoverParts.filter(hoverPart => hoverPart.owner === participant);
			const hasHoverPartsForParticipant = hoverPartsForParticipant.length > 0;
			if (!hasHoverPartsForParticipant) {
				continue;
			}
			disposables.add(participant.renderHoverParts(context, hoverPartsForParticipant));
		}
		return disposables;
	}

	private _renderStatusBar(fragment: DocumentFragment, statusBar: EditorHoverStatusBar): IDisposable {
		if (!statusBar.hasContent) {
			return Disposable.None;
		}
		fragment.appendChild(statusBar.hoverElement);
		return statusBar;
	}

	public get domNode(): DocumentFragment {
		return this._fragment;
	}
}
