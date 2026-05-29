/**
 * Code block node with language picker.
 *
 * Wraps the base `@tiptap/extension-code-block` with a React node view that
 * overlays a small language chip in the top-right corner. Clicking the chip
 * opens a popover with a Kumo Autocomplete: a free-form text input plus a
 * filtered list of curated language suggestions. The value is persisted on
 * the node's `language` attribute and round-trips through Portable Text as
 * `block.language`.
 *
 * The picker accepts arbitrary strings (not restricted to the curated list)
 * so that less common languages can still be used. Free-form input is
 * sanitized to a single safe CSS class token via `normalizeLanguage` so the
 * frontend's `language-{id}` class stays well-formed.
 */

import { Autocomplete, Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Check, X } from "@phosphor-icons/react";
import CodeBlock from "@tiptap/extension-code-block";
import type { NodeViewProps } from "@tiptap/react";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import * as React from "react";

import { CODE_BLOCK_LANGUAGES, languageLabel, normalizeLanguage } from "./codeBlockLanguages";

const LANGUAGE_ITEMS = CODE_BLOCK_LANGUAGES.map((l) => l.label);

/**
 * Marker class applied to the language dropdown's popup. The dropdown is
 * rendered through Base UI's Portal, so its DOM lives at `document.body` --
 * outside the picker's `popoverRef`. We use this class to recognise it as
 * part of the picker in the outside-click handler.
 */
export const LANGUAGE_PICKER_POPUP_CLASS = "emdash-language-picker-popup";

/**
 * Decide whether a pointer event should dismiss the open language picker.
 *
 * Returns true only for events that land genuinely outside the picker. The
 * subtlety (issue #1200): the Autocomplete suggestion list is portalled to
 * `document.body`, so it is not a descendant of `popoverRef`. A naive
 * "mousedown outside the popover closes it" check treats clicks on the
 * dropdown -- including selecting a language -- as outside and tears the
 * picker down before the selection commits, so it looks like the picker
 * "loses focus and closes". Treat anything inside the portalled popup as
 * part of the picker.
 */
export function shouldDismissPicker(target: Node | null, popover: HTMLElement | null): boolean {
	if (!popover || !target) return false;
	if (popover.contains(target)) return false;
	if (target instanceof Element && target.closest(`.${LANGUAGE_PICKER_POPUP_CLASS}`)) {
		return false;
	}
	return true;
}

function filterLanguages(item: string, query: string) {
	if (!query) return true;
	const needle = query.toLowerCase();
	const lang = CODE_BLOCK_LANGUAGES.find((l) => l.label === item);
	if (!lang) return false;
	if (lang.label.toLowerCase().includes(needle)) return true;
	if (lang.id.toLowerCase().includes(needle)) return true;
	return lang.aliases?.some((alias) => alias.toLowerCase().includes(needle)) ?? false;
}

/**
 * Tells password managers / autofill extensions to leave the language input
 * alone. Keeper (seen in the wild setting `data-keeper-edited`) respects the
 * `keeper-ignore` class; 1Password / LastPass / Bitwarden respect the data-*
 * attributes. Without this, the extension injects into the input and toggles
 * a focus guard that marks the surrounding editor content `aria-hidden`,
 * which makes ProseMirror redraw and recreate the code block node view --
 * tearing the picker down mid-edit (issue #1200). Mirrors Kumo's
 * `<Input passwordManagerIgnore>`, which `Autocomplete.InputGroup` does not
 * expose, so we apply it by hand to the input and the picker container.
 */
const PASSWORD_MANAGER_IGNORE_CLASS = "keeper-ignore";
const PASSWORD_MANAGER_IGNORE_ATTRS = {
	"data-1p-ignore": "true",
	"data-lpignore": "true",
	"data-bwignore": "true",
	"data-form-type": "other",
} as const;

function CodeBlockNodeView({ node, updateAttributes, selected }: NodeViewProps) {
	const { t } = useLingui();
	const [isEditing, setIsEditing] = React.useState(false);
	const storedLanguage = typeof node.attrs.language === "string" ? node.attrs.language : "";
	const [draft, setDraft] = React.useState(() => languageLabel(storedLanguage));
	const popoverRef = React.useRef<HTMLDivElement>(null);

	// Sync draft when the stored language changes from outside the node view
	// (e.g. another collaborator edits the attribute, or the editor reloads
	// content). Don't clobber an in-progress edit.
	React.useEffect(() => {
		if (!isEditing) {
			setDraft(languageLabel(storedLanguage));
		}
	}, [storedLanguage, isEditing]);

	const openPicker = React.useCallback(() => {
		setDraft(storedLanguage ? languageLabel(storedLanguage) : "");
		setIsEditing(true);
	}, [storedLanguage]);

	const closePicker = React.useCallback(() => {
		setIsEditing(false);
		setDraft(languageLabel(storedLanguage));
	}, [storedLanguage]);

	const commit = React.useCallback(
		(value?: string) => {
			const raw = value ?? draft;
			const next = normalizeLanguage(raw);
			updateAttributes({ language: next ?? null });
			setIsEditing(false);
		},
		[draft, updateAttributes],
	);

	const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			commit();
		} else if (e.key === "Escape") {
			e.preventDefault();
			closePicker();
		}
	};

	// Close on outside click while the popover is open.
	React.useEffect(() => {
		if (!isEditing) return undefined;
		const onMouseDown = (event: MouseEvent) => {
			// Ignore synthetic events. Browser extensions (password managers,
			// autofill) that inject into inputs dispatch untrusted pointer
			// events; treating those as "the user clicked away" is what made
			// the picker close mid-typing for some users (issue #1200).
			if (!event.isTrusted) return;
			const target = event.target instanceof Node ? event.target : null;
			if (shouldDismissPicker(target, popoverRef.current)) {
				closePicker();
			}
		};
		document.addEventListener("mousedown", onMouseDown);
		return () => document.removeEventListener("mousedown", onMouseDown);
	}, [isEditing, closePicker]);

	const label = languageLabel(storedLanguage);
	// The chip is always rendered (so it can be discovered via hover) but its
	// opacity is controlled by CSS: invisible by default, visible on hover,
	// when this block is selected, when the picker is open, or when the
	// block already has a language set. When hidden, also remove it from the
	// tab order so it doesn't trap keyboard focus.
	const chipPersistent = isEditing || Boolean(storedLanguage) || selected;

	return (
		<NodeViewWrapper className="group relative my-4" data-language={storedLanguage || undefined}>
			<pre className="emdash-code-block">
				<NodeViewContent<"code"> as="code" />
			</pre>

			<div className="absolute end-2 top-2 select-none" contentEditable={false}>
				{isEditing ? (
					<div
						ref={popoverRef}
						className={`flex items-center gap-1 rounded-md border bg-kumo-overlay p-1 shadow-lg ${PASSWORD_MANAGER_IGNORE_CLASS}`}
						onKeyDown={handleKeyDown}
						{...PASSWORD_MANAGER_IGNORE_ATTRS}
					>
						<Autocomplete
							items={LANGUAGE_ITEMS}
							value={draft}
							onValueChange={(next: string) => setDraft(next)}
							filter={filterLanguages}
						>
							<Autocomplete.InputGroup
								size="sm"
								placeholder={t`Language`}
								className={PASSWORD_MANAGER_IGNORE_CLASS}
							/>
							<Autocomplete.Content sideOffset={4} className={LANGUAGE_PICKER_POPUP_CLASS}>
								<Autocomplete.List>
									{(item: string) => (
										<Autocomplete.Item key={item} value={item}>
											{item}
										</Autocomplete.Item>
									)}
								</Autocomplete.List>
								<Autocomplete.Empty>{t`No matches`}</Autocomplete.Empty>
							</Autocomplete.Content>
						</Autocomplete>
						<Button
							type="button"
							variant="ghost"
							shape="square"
							className="h-7 w-7"
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => commit()}
							title={t`Apply language`}
							aria-label={t`Apply language`}
						>
							<Check className="h-4 w-4" />
						</Button>
						<Button
							type="button"
							variant="ghost"
							shape="square"
							className="h-7 w-7"
							onMouseDown={(e) => e.preventDefault()}
							onClick={closePicker}
							title={t`Cancel`}
							aria-label={t`Cancel`}
						>
							<X className="h-4 w-4" />
						</Button>
					</div>
				) : (
					<button
						type="button"
						tabIndex={chipPersistent ? 0 : -1}
						onMouseDown={(e) => e.preventDefault()}
						onClick={openPicker}
						className="rounded-md border bg-kumo-overlay/90 px-2 py-1 text-xs text-kumo-subtle opacity-0 transition-opacity hover:text-kumo-strong focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-kumo-brand group-hover:opacity-100 data-[persistent=true]:opacity-100"
						data-persistent={chipPersistent ? "true" : "false"}
						title={t`Set language`}
						aria-label={t`Set language (current: ${label})`}
						aria-hidden={chipPersistent ? undefined : true}
					>
						{storedLanguage ? label : t`Set language`}
					</button>
				)}
			</div>
		</NodeViewWrapper>
	);
}

/**
 * Decide whether ProseMirror should ignore a DOM mutation inside this node
 * view.
 *
 * The node view renders the editable code content *and* an interactive
 * language-picker overlay. Browser extensions (password managers, autofill)
 * mutate the DOM around the picker's input as you type; if ProseMirror
 * reacts to those mutations it recreates the entire React node view, which
 * throws away the picker's transient open state mid-edit and makes it
 * vanish -- the reported "loses focus and closes" behaviour (issue #1200).
 *
 * Only mutations inside the editable code content (`pre.emdash-code-block`)
 * are real edits ProseMirror must observe. Ignore everything else -- the
 * overlay and anything injected into it -- so the node view is never
 * recreated by picker UI or extension churn. Selection changes are always
 * handled by ProseMirror.
 */
export function ignoreCodeBlockMutation(mutation: { type: string; target: Node }): boolean {
	if (mutation.type === "selection") return false;
	const node = mutation.target;
	const el = node instanceof Element ? node : node.parentElement;
	return !el?.closest("pre.emdash-code-block");
}

/**
 * TipTap extension: code block with an inline language picker node view.
 *
 * Drop-in replacement for StarterKit's default `codeBlock`. Configure
 * `StarterKit.configure({ codeBlock: false })` and add this extension to
 * the editor's extensions array.
 */
export const CodeBlockExtension = CodeBlock.extend({
	addNodeView() {
		return ReactNodeViewRenderer(CodeBlockNodeView, {
			ignoreMutation: ({ mutation }) => ignoreCodeBlockMutation(mutation),
		});
	},
});
