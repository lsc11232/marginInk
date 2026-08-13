const { Plugin, Modal, Notice, TFile, ItemView, Menu, setIcon } = require("obsidian");

const DEFAULT_DATA = { version: 2, documents: {} };
const DEFAULT_HIGHLIGHT = "#ffd54f";
const PALETTE_COLORS = ["#27272a", "#71717a", "#ffd54f", "#fb923c", "#f87171", "#f472b6", "#a78bfa", "#60a5fa", "#5eead4", "#86efac", "#bef264", "#fde68a"];
const TEXT_COLOR_OPTIONS = [["#3f3f46", "墨黑"], ["#ef4444", "红色"], ["#f97316", "橙色"], ["#ca8a04", "金黄"], ["#16a34a", "绿色"], ["#2563eb", "蓝色"], ["#7c3aed", "紫色"]];
const ANNOTATION_VIEW_TYPE = "margin-ink-annotations";

function id() {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function validColor(value, fallback = DEFAULT_HIGHLIGHT) {
	return /^#[0-9a-f]{6}$/i.test(value || "") ? value : fallback;
}

function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

function editableText(element) {
	let result = "";
	const visit = (node) => {
		if (node.nodeType === Node.TEXT_NODE) {
			result += node.nodeValue || "";
			return;
		}
		if (!(node instanceof HTMLElement)) return;
		if (node.tagName === "BR") { result += "\n"; return; }
		const block = ["DIV", "P", "LI"].includes(node.tagName);
		if (block && result && !result.endsWith("\n")) result += "\n";
		for (const child of node.childNodes) visit(child);
		if (block && result && !result.endsWith("\n")) result += "\n";
	};
	for (const child of element.childNodes) visit(child);
	return result.replace(/\n{3,}/g, "\n\n").replace(/\n$/, "");
}

function escapeHtml(value) {
	const element = document.createElement("div");
	element.textContent = value;
	return element.innerHTML;
}

function normalizedColor(value) {
	if (validColor(value, "")) return value.toLowerCase();
	const rgb = String(value || "").match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
	if (!rgb) return null;
	return `#${[rgb[1], rgb[2], rgb[3]].map((part) => Number(part).toString(16).padStart(2, "0")).join("")}`;
}

function sanitizeNoteHtml(html) {
	const root = document.createElement("div");
	root.innerHTML = html || "";
	const render = (node) => {
		if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.nodeValue || "");
		if (!(node instanceof HTMLElement)) return "";
		if (node.tagName === "BR") return "<br>";
		const content = Array.from(node.childNodes).map(render).join("");
		if (["SPAN", "FONT"].includes(node.tagName)) {
			const color = normalizedColor(node.style.color || node.getAttribute("color"));
			return color ? `<span style="color:${color}">${content}</span>` : content;
		}
		if (["DIV", "P", "LI"].includes(node.tagName)) return `${content}<br>`;
		return content;
	};
	return Array.from(root.childNodes).map(render).join("").replace(/(?:<br>){2,}$/g, "<br>");
}

class FloatingNoteModal extends Modal {
	constructor(plugin, options) {
		super(plugin.app);
		this.plugin = plugin;
		this.options = options;
	}

	onOpen() {
		const { contentEl } = this;
		const note = this.options.note || {};
		contentEl.addClass("sidecar-note-modal");
		contentEl.createEl("h2", { text: "添加浮动标注" });
		if (this.options.quote) {
			contentEl.createEl("p", { cls: "sidecar-note-modal__quote", text: `关联文字：${this.options.quote}` });
		}

		const text = contentEl.createEl("textarea", {
			cls: "sidecar-note-modal__text",
			attr: { placeholder: "输入你的标注…" }
		});
		text.value = note.text || "";

		const controls = contentEl.createDiv({ cls: "sidecar-note-modal__controls" });
		const colorLabel = controls.createEl("label", { text: "文字颜色" });
		const color = colorLabel.createEl("select");
		TEXT_COLOR_OPTIONS.forEach(([value, label]) => color.createEl("option", { value, text: label }));
		color.value = TEXT_COLOR_OPTIONS.some(([value]) => value === note.color) ? note.color : "#3f3f46";
		const sizeLabel = controls.createEl("label", { text: "文字大小" });
		const sizeControl = sizeLabel.createDiv({ cls: "sidecar-note-modal__number" });
		const size = sizeControl.createEl("input", { attr: { type: "number", min: "12", max: "32", value: String(note.fontSize || 15) } });
		sizeControl.createSpan({ text: "px" });

		const actions = contentEl.createDiv({ cls: "sidecar-note-modal__actions" });
		const cancel = actions.createEl("button", { text: "取消" });
		cancel.onclick = () => this.close();
		const save = actions.createEl("button", { text: "保存", cls: "mod-cta" });
		save.onclick = async () => {
			const content = text.value.trim();
			if (!content) {
				new Notice("请先输入标注内容");
				return;
			}
			await this.plugin.saveComment(this.options, {
				...note,
				text: content,
				color: validColor(color.value, "#3f3f46"),
				fontSize: clamp(Number(size.value) || 15, 12, 32)
			});
			this.close();
		};
		window.setTimeout(() => text.focus(), 20);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class MarginInkAnnotationView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() { return ANNOTATION_VIEW_TYPE; }
	getDisplayText() { return "MarginInk 标注"; }
	getIcon() { return "list"; }

	async onOpen() {
		this.plugin.annotationViews.add(this);
		this.render();
	}

	async onClose() {
		this.plugin.annotationViews.delete(this);
	}

	render() {
		const root = this.contentEl;
		root.empty();
		root.addClass("margin-ink-sidebar");
		root.createEl("h4", { text: "当前笔记标注" });
		const file = this.plugin.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== "md") {
			root.createEl("p", { cls: "margin-ink-sidebar__empty", text: "打开一篇 Markdown 笔记后显示浮动标注。" });
			return;
		}
		const comments = this.plugin.data.documents[file.path]?.comments || [];
		if (!comments.length) {
			root.createEl("p", { cls: "margin-ink-sidebar__empty", text: "当前笔记还没有浮动标注。高亮和下划线不会显示在这里。" });
			return;
		}
		for (const note of comments) {
			const item = root.createDiv({ cls: "margin-ink-sidebar__item" });
			item.style.setProperty("--margin-ink-note-color", validColor(note.color, "#3f3f46"));
			item.createEl("div", { cls: "margin-ink-sidebar__text", text: note.text || "未命名标注" });
			if (note.quote) item.createEl("div", { cls: "margin-ink-sidebar__quote", text: `关联：${note.quote}` });
			item.onclick = () => this.plugin.jumpToComment(note.id);
		}
	}
}

module.exports = class SidecarAnnotationsPlugin extends Plugin {
	async onload() {
		this.data = { ...DEFAULT_DATA, ...(await this.loadData() || {}) };
		this.data.documents ||= {};
		this.data.version = 2;
		this.pendingSelection = null;
		this.annotationViews = new Set();
		this.registerView(ANNOTATION_VIEW_TYPE, (leaf) => new MarginInkAnnotationView(leaf, this));
		this.toolbar = this.createToolbar();
		document.body.appendChild(this.toolbar);
		this.register(() => this.toolbar.remove());
		this.textStyleToolbar = this.createTextStyleToolbar();
		document.body.appendChild(this.textStyleToolbar);
		this.register(() => this.textStyleToolbar.remove());

		this.addRibbonIcon("highlighter", "MarginInk：给选中的文字添加独立标注", () => this.showToolbarForSelection());
		this.addRibbonIcon("undo-2", "MarginInk：撤销上一次标注操作", () => this.undoLastAction());
		this.addRibbonIcon("list", "MarginInk：显示当前笔记的浮动标注", () => this.openAnnotationSidebar());
		this.addCommand({
			id: "add-floating-note",
			name: "为选中文字添加浮动标注",
			checkCallback: (checking) => {
				const selection = this.readSelection();
				if (!selection) return false;
				if (!checking) this.openNewComment(selection);
				return true;
			}
		});
		this.addCommand({ id: "undo-last-annotation", name: "撤销上一次标注操作", callback: () => this.undoLastAction() });
		this.addCommand({ id: "export-annotated-note", name: "导出带标注的新笔记", callback: () => this.exportActiveFile() });
		this.addCommand({ id: "show-current-file-annotations", name: "显示当前笔记的浮动标注", callback: () => this.openAnnotationSidebar() });

		this.registerDomEvent(document, "mouseup", () => window.setTimeout(() => this.showToolbarForSelection(), 0), true);
		this.registerDomEvent(document, "mousedown", (event) => {
			if (!this.toolbar.contains(event.target)) this.hideToolbar();
			if (!this.textStyleToolbar.contains(event.target) && !(event.target instanceof Element && event.target.closest(".sidecar-floating-note"))) this.hideTextStyleToolbar();
		}, true);
		this.registerDomEvent(document, "keydown", (event) => {
			if (event.key.toLowerCase() !== "z" || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
			const target = event.target instanceof HTMLElement ? event.target : null;
			if (target?.closest("input, textarea, select, [contenteditable='true'], .cm-editor")) return;
			const file = this.app.workspace.getActiveFile();
			if (!(file instanceof TFile) || file.extension !== "md") return;
			event.preventDefault();
			this.undoLastAction();
		}, true);
		this.registerEvent(this.app.workspace.on("file-open", () => { this.queueRefresh(); this.refreshAnnotationSidebars(); }));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.queueRefresh()));
		this.registerMarkdownPostProcessor((element, context) => {
			const view = element.closest(".markdown-preview-view");
			if (view && context.sourcePath) this.queueRender(view, context.sourcePath);
		});
		this.app.workspace.onLayoutReady(() => this.queueRefresh());
	}

	onunload() {
		document.querySelectorAll(".sidecar-annotation-layer").forEach((el) => el.remove());
		document.querySelectorAll(".sidecar-mark").forEach((el) => el.replaceWith(...el.childNodes));
	}

	async persist() {
		await this.saveData(this.data);
		this.refreshAnnotationSidebars();
	}

	async openAnnotationSidebar() {
		let leaf = this.app.workspace.getLeavesOfType(ANNOTATION_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false);
			await leaf.setViewState({ type: ANNOTATION_VIEW_TYPE, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
		this.refreshAnnotationSidebars();
	}

	refreshAnnotationSidebars() {
		for (const view of this.annotationViews) view.render();
	}

	findCommentElement(path, commentId) {
		for (const root of document.querySelectorAll(".markdown-preview-sizer")) {
			if (root.dataset.marginInkPath && root.dataset.marginInkPath !== path) continue;
			for (const element of root.querySelectorAll(".sidecar-floating-note")) {
				if (element.dataset.noteId === commentId) return element;
			}
		}
		return null;
	}

	async jumpToComment(commentId) {
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== "md") return new Notice("请先打开标注所属的 Markdown 笔记");
		const note = this.data.documents[file.path]?.comments?.find((item) => item.id === commentId);
		if (!note) return new Notice("找不到这条标注的数据");
		let target = this.findCommentElement(file.path, commentId);
		if (!target) {
			for (const root of document.querySelectorAll(".markdown-preview-sizer")) {
				const preview = root.closest(".markdown-preview-view");
				if (preview) this.renderDocument(preview, file.path);
			}
			await new Promise((resolve) => window.setTimeout(resolve, 80));
			target = this.findCommentElement(file.path, commentId);
		}
		if (target) {
			target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
			target.classList.add("is-jumping-to");
			window.setTimeout(() => target?.classList.remove("is-jumping-to"), 1200);
			return;
		}
		const root = Array.from(document.querySelectorAll(".markdown-preview-sizer")).find((item) => item.dataset.marginInkPath === file.path);
		const preview = root?.closest(".markdown-preview-view");
		if (preview) {
			preview.scrollTo({ top: Math.max(0, (Number(note.y) || 0) - 140), behavior: "smooth" });
			new Notice("已滚动到标注位置附近，正在等待阅读视图渲染");
			return;
		}
		new Notice("当前笔记的阅读视图尚未完成渲染，请稍后再试");
	}

	documentFor(path) {
		if (!this.data.documents[path]) this.data.documents[path] = { highlights: [], comments: [], history: [] };
		const doc = this.data.documents[path];
		doc.highlights ||= [];
		doc.comments ||= [];
		doc.history ||= [];
		return doc;
	}

	recordHistory(path, action) {
		const history = this.documentFor(path).history;
		history.push(action);
		if (history.length > 100) history.splice(0, history.length - 100);
	}

	async undoLastAction() {
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== "md") return new Notice("请先打开一篇 Markdown 笔记");
		const doc = this.documentFor(file.path);
		const action = doc.history.pop();
		if (!action) return new Notice("这篇笔记没有可撤销的标注操作");
		if (action.type === "highlight-created") {
			doc.highlights = doc.highlights.filter((item) => item.id !== action.value.id);
		} else if (action.type === "highlight-deleted") {
			doc.highlights.splice(action.index, 0, action.value);
		} else if (action.type === "comment-created") {
			doc.comments = doc.comments.filter((item) => item.id !== action.value.id);
		} else if (action.type === "comment-deleted") {
			doc.comments.splice(action.index, 0, action.value);
		} else if (action.type === "comment-updated" || action.type === "comment-moved" || action.type === "comment-resized" || action.type === "comment-style") {
			const index = doc.comments.findIndex((item) => item.id === action.id);
			if (index !== -1) doc.comments[index] = { ...doc.comments[index], ...action.before };
		}
		await this.persist();
		this.queueRefresh();
		new Notice("已撤销上一项 MarginInk 标注操作");
	}

	queueRefresh() {
		window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			const file = this.app.workspace.getActiveFile();
			if (!(file instanceof TFile) || file.extension !== "md") return;
			document.querySelectorAll(".markdown-preview-view").forEach((view) => this.renderDocument(view, file.path));
		}, 120);
	}

	queueRender(view, path) {
		window.clearTimeout(view._sidecarAnnotationTimer);
		view._sidecarAnnotationTimer = window.setTimeout(() => this.renderDocument(view, path), 80);
	}

	createToolbar() {
		const bar = document.createElement("div");
		bar.className = "sidecar-annotation-toolbar";
		bar.setAttribute("aria-label", "独立标注工具栏");
		const colorButton = document.createElement("button");
		colorButton.className = "sidecar-annotation-toolbar__color";
		colorButton.textContent = "A";
		colorButton.title = "使用当前颜色高亮";
		colorButton.style.setProperty("--active-color", DEFAULT_HIGHLIGHT);
		colorButton.onmousedown = (event) => event.preventDefault();
		colorButton.onclick = () => this.addHighlight("highlight", this.annotationColor);
		bar.appendChild(colorButton);
		const colorMenuButton = document.createElement("button");
		colorMenuButton.className = "sidecar-annotation-toolbar__color-menu";
		colorMenuButton.title = "选择默认高亮颜色";
		colorMenuButton.setAttribute("aria-label", "选择默认高亮颜色");
		setIcon(colorMenuButton, "chevron-down");
		colorMenuButton.onmousedown = (event) => event.preventDefault();
		colorMenuButton.onclick = () => bar.classList.toggle("is-palette-open");
		bar.appendChild(colorMenuButton);

		const palette = document.createElement("div");
		palette.className = "sidecar-annotation-toolbar__palette";
		PALETTE_COLORS.forEach((color) => {
			const button = document.createElement("button");
			button.className = "sidecar-annotation-toolbar__swatch";
			button.style.setProperty("--swatch", color);
			button.title = `设为默认高亮颜色：${color}`;
			button.onmousedown = (event) => event.preventDefault();
			button.onclick = () => this.setAnnotationColor(color);
			palette.appendChild(button);
		});
		bar.appendChild(palette);
		this.annotationColor = DEFAULT_HIGHLIGHT;
		this.annotationColorButton = colorButton;
		this.addToolbarIcon(bar, "bold", "加粗", () => this.addHighlight("bold"), "sidecar-annotation-toolbar__bold");
		this.addToolbarIcon(bar, "strikethrough", "删除线", () => this.addHighlight("strike"), "sidecar-annotation-toolbar__strike");
		this.addToolbarIcon(bar, "italic", "斜体", () => this.addHighlight("italic"), "sidecar-annotation-toolbar__italic");
		const underlineButton = this.addToolbarIcon(bar, "underline", "使用当前颜色画下划线", () => this.addHighlight("underline", this.underlineColor), "sidecar-annotation-toolbar__underline");
		underlineButton.style.setProperty("--active-color", DEFAULT_HIGHLIGHT);
		const underlineMenuButton = document.createElement("button");
		underlineMenuButton.className = "sidecar-annotation-toolbar__color-menu";
		underlineMenuButton.title = "选择默认下划线颜色";
		underlineMenuButton.setAttribute("aria-label", "选择默认下划线颜色");
		setIcon(underlineMenuButton, "chevron-down");
		underlineMenuButton.onmousedown = (event) => event.preventDefault();
		underlineMenuButton.onclick = () => bar.classList.toggle("is-underline-palette-open");
		bar.appendChild(underlineMenuButton);
		const underlinePalette = document.createElement("div");
		underlinePalette.className = "sidecar-annotation-toolbar__palette sidecar-annotation-toolbar__underline-palette";
		PALETTE_COLORS.forEach((color) => {
			const button = document.createElement("button");
			button.className = "sidecar-annotation-toolbar__swatch";
			button.style.setProperty("--swatch", color);
			button.title = `设为默认下划线颜色：${color}`;
			button.onmousedown = (event) => event.preventDefault();
			button.onclick = () => this.setUnderlineColor(color);
			underlinePalette.appendChild(button);
		});
		bar.appendChild(underlinePalette);
		this.underlineColor = DEFAULT_HIGHLIGHT;
		this.underlineColorButton = underlineButton;
		this.addToolbarIcon(bar, "message-square", "添加浮动文字标注", () => this.openNewComment(this.pendingSelection), "sidecar-annotation-toolbar__comment");
		return bar;
	}

	setAnnotationColor(color) {
		const next = validColor(color);
		this.annotationColor = next;
		this.annotationColorButton.style.setProperty("--active-color", next);
		this.toolbar.classList.remove("is-palette-open", "is-underline-palette-open");
	}

	setUnderlineColor(color) {
		const next = validColor(color);
		this.underlineColor = next;
		this.underlineColorButton.style.setProperty("--active-color", next);
		this.toolbar.classList.remove("is-palette-open", "is-underline-palette-open");
	}

	addToolbarButton(parent, text, title, handler, cls = "") {
		const button = document.createElement("button");
		button.textContent = text;
		button.title = title;
		button.className = cls;
		button.onmousedown = (event) => event.preventDefault();
		button.onclick = handler;
		parent.appendChild(button);
		return button;
	}

	addToolbarIcon(parent, icon, title, handler, cls = "") {
		const button = this.addToolbarButton(parent, "", title, handler, cls);
		setIcon(button, icon);
		return button;
	}

	readSelection() {
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
		const range = selection.getRangeAt(0);
		const preview = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
			? range.commonAncestorContainer.closest(".markdown-preview-view")
			: range.commonAncestorContainer.parentElement?.closest(".markdown-preview-view");
		const file = this.app.workspace.getActiveFile();
		const quote = selection.toString().replace(/\s+/g, " ").trim();
		if (!preview || !(file instanceof TFile) || file.extension !== "md" || !quote) return null;
		const root = preview.querySelector(".markdown-preview-sizer");
		if (!root || !root.contains(range.commonAncestorContainer)) return null;
		const text = root.textContent || "";
		const preRange = document.createRange();
		preRange.selectNodeContents(root);
		preRange.setEnd(range.startContainer, range.startOffset);
		const start = preRange.toString().length;
		const end = start + selection.toString().length;
		const rect = range.getBoundingClientRect();
		return {
			path: file.path,
			quote,
			previewPrefix: text.slice(Math.max(0, start - 48), start),
			previewSuffix: text.slice(end, end + 48),
			rect: { left: rect.left, top: rect.top, bottom: rect.bottom },
			range: range.cloneRange()
		};
	}

	showToolbarForSelection() {
		const selection = this.readSelection();
		if (!selection) return this.hideToolbar();
		this.pendingSelection = selection;
		this.toolbar.classList.add("is-visible");
		const pane = selection.range.commonAncestorContainer.parentElement?.closest(".workspace-leaf-content") || selection.range.commonAncestorContainer.parentElement?.closest(".markdown-preview-view");
		const bounds = pane?.getBoundingClientRect() || { left: 0, right: window.innerWidth };
		const toolbarWidth = this.toolbar.getBoundingClientRect().width || 230;
		this.toolbar.style.left = `${clamp(selection.rect.left, bounds.left + 8, Math.max(bounds.left + 8, bounds.right - toolbarWidth - 8))}px`;
		this.toolbar.style.top = `${clamp(selection.rect.top - 48, 8, window.innerHeight - 55)}px`;
	}

	hideToolbar() {
		this.toolbar.classList.remove("is-visible", "is-palette-open", "is-underline-palette-open");
	}

	createTextStyleToolbar() {
		const bar = document.createElement("div");
		bar.className = "sidecar-text-style-toolbar";
		bar.setAttribute("aria-label", "文本框格式工具栏");
		const font = document.createElement("select");
		font.title = "字体";
		[
			["var(--font-text)", "系统字体"],
			["Times New Roman, serif", "Times New Roman"],
			["Georgia, serif", "Georgia"],
			["Courier New, monospace", "Courier New"]
		].forEach(([value, label]) => {
			const option = document.createElement("option");
			option.value = value; option.textContent = label; font.appendChild(option);
		});
		font.onchange = () => this.updateActiveNoteStyle({ fontFamily: font.value });
		bar.appendChild(font);

		const size = document.createElement("div");
		size.className = "sidecar-text-style-toolbar__size";
		const smaller = document.createElement("button");
		smaller.textContent = "−"; smaller.title = "缩小字号";
		const sizeValue = document.createElement("span");
		const larger = document.createElement("button");
		larger.textContent = "+"; larger.title = "放大字号";
		smaller.onmousedown = (event) => event.preventDefault();
		larger.onmousedown = (event) => event.preventDefault();
		smaller.onclick = () => this.changeActiveNoteFontSize(-1);
		larger.onclick = () => this.changeActiveNoteFontSize(1);
		size.append(smaller, sizeValue, larger);
		bar.appendChild(size);

		const color = document.createElement("button");
		color.className = "sidecar-text-style-toolbar__color";
		color.textContent = "A"; color.title = "文字颜色";
		color.onmousedown = (event) => event.preventDefault();
		color.onclick = () => bar.classList.toggle("is-palette-open");
		bar.appendChild(color);
		const palette = document.createElement("div");
		palette.className = "sidecar-text-style-toolbar__palette";
		PALETTE_COLORS.forEach((value) => {
			const swatch = document.createElement("button");
			swatch.className = "sidecar-text-style-toolbar__swatch";
			swatch.style.setProperty("--swatch", value);
			swatch.title = `文字颜色 ${value}`;
			swatch.onmousedown = (event) => event.preventDefault();
			swatch.onclick = () => {
				bar.classList.remove("is-palette-open");
				this.applySelectedTextColor(value);
			};
			palette.appendChild(swatch);
		});
		bar.appendChild(palette);

		const toggles = [["bold", "bold", "粗体"], ["italic", "italic", "斜体"], ["underline", "underline", "下划线"], ["strike", "strikethrough", "删除线"]];
		for (const [key, icon, title] of toggles) {
			const button = document.createElement("button");
			button.className = `sidecar-text-style-toolbar__toggle sidecar-text-style-toolbar__toggle--${key}`;
			button.title = title;
			setIcon(button, icon);
			button.onmousedown = (event) => event.preventDefault();
			button.onclick = () => this.updateActiveNoteStyle({ [key]: !this.activeNote?.note[key] });
			bar.appendChild(button);
		}
		const remove = document.createElement("button");
		remove.className = "sidecar-text-style-toolbar__delete";
		remove.title = "删除文本框";
		setIcon(remove, "trash-2");
		remove.onmousedown = (event) => event.preventDefault();
		remove.onclick = () => this.removeActiveComment();
		bar.appendChild(remove);
		this.textStyleControls = { font, sizeValue, color, toggles: new Map() };
		bar.querySelectorAll(".sidecar-text-style-toolbar__toggle").forEach((button) => {
			this.textStyleControls.toggles.set(button.className.match(/--(bold|italic|underline|strike)/)[1], button);
		});
		return bar;
	}

	showTextStyleToolbar(box, note, path, content) {
		this.activeNote = { box, note, path, content };
		const controls = this.textStyleControls;
		controls.font.value = note.fontFamily || "var(--font-text)";
		controls.sizeValue.textContent = String(clamp(Number(note.fontSize) || 15, 12, 32));
		controls.color.style.setProperty("--active-color", validColor(note.color, "#3f3f46"));
		for (const [key, button] of controls.toggles) button.classList.toggle("is-active", Boolean(note[key]));
		this.textStyleToolbar.classList.add("is-visible");
		const rect = box.getBoundingClientRect();
		const width = this.textStyleToolbar.getBoundingClientRect().width;
		const pane = box.closest(".workspace-leaf-content") || box.closest(".markdown-preview-view");
		const bounds = pane?.getBoundingClientRect() || { left: 0, right: window.innerWidth };
		this.textStyleToolbar.style.left = `${clamp(rect.left, bounds.left + 8, Math.max(bounds.left + 8, bounds.right - width - 8))}px`;
		this.textStyleToolbar.style.top = `${clamp(rect.top - 58, 8, window.innerHeight - 52)}px`;
	}

	hideTextStyleToolbar() {
		this.textStyleToolbar.classList.remove("is-visible", "is-palette-open");
		this.activeNote = null;
	}

	changeActiveNoteFontSize(delta) {
		if (!this.activeNote) return;
		this.updateActiveNoteStyle({ fontSize: clamp((Number(this.activeNote.note.fontSize) || 15) + delta, 12, 32) });
	}

	async applySelectedTextColor(color) {
		if (!this.activeNote) return;
		const { note, path, box, content } = this.activeNote;
		const selection = window.getSelection();
		const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
		const hasTextSelection = Boolean(range && !range.collapsed && content.contains(range.commonAncestorContainer));
		if (!hasTextSelection) return this.updateActiveNoteStyle({ color });
		const doc = this.documentFor(path);
		const index = doc.comments.findIndex((item) => item.id === note.id);
		if (index === -1) return;
		const before = { text: note.text, html: note.html || "" };
		document.execCommand("styleWithCSS", false, true);
		document.execCommand("foreColor", false, color);
		note.text = editableText(content).trim();
		note.html = sanitizeNoteHtml(content.innerHTML);
		doc.comments[index].text = note.text;
		doc.comments[index].html = note.html;
		content.dataset.originalText = note.text;
		content.dataset.originalHtml = note.html;
		this.recordHistory(path, { type: "comment-updated", id: note.id, before });
		this.textStyleControls.color.style.setProperty("--active-color", color);
		const root = box.closest(".markdown-preview-sizer");
		if (root) this.fitNoteToText(box, content, note, root);
		await this.persist();
	}

	async removeActiveComment() {
		if (!this.activeNote) return;
		const { path, note } = this.activeNote;
		this.hideTextStyleToolbar();
		await this.removeComment(path, note.id);
		new Notice("已删除文本框；可使用撤销恢复");
	}

	async updateActiveNoteStyle(patch) {
		if (!this.activeNote) return;
		const { note, path, box, content } = this.activeNote;
		const doc = this.documentFor(path);
		const index = doc.comments.findIndex((item) => item.id === note.id);
		if (index === -1) return;
		const before = {};
		for (const key of Object.keys(patch)) before[key] = note[key];
		Object.assign(note, patch);
		Object.assign(doc.comments[index], patch);
		this.recordHistory(path, { type: "comment-style", id: note.id, before });
		this.applyNoteStyle(box, content, note);
		const root = box.closest(".markdown-preview-sizer");
		if (root) this.fitNoteToText(box, content, note, root);
		this.showTextStyleToolbar(box, note, path, content);
		await this.persist();
	}

	applyNoteStyle(box, content, note) {
		box.style.setProperty("--sidecar-note-color", validColor(note.color, "#3f3f46"));
		box.style.setProperty("--sidecar-note-size", `${clamp(Number(note.fontSize) || 15, 12, 32)}px`);
		content.style.fontFamily = note.fontFamily || "var(--font-text)";
		content.style.fontWeight = note.bold ? "700" : "400";
		content.style.fontStyle = note.italic ? "italic" : "normal";
		content.style.textDecoration = [note.underline ? "underline" : "", note.strike ? "line-through" : ""].filter(Boolean).join(" ") || "none";
	}

	async addHighlight(kind, color) {
		const selection = this.pendingSelection || this.readSelection();
		if (!selection) return new Notice("请先在阅读视图中选中一段文字");
		const doc = this.documentFor(selection.path);
		const mark = {
			id: id(), kind, color: validColor(color), quote: selection.quote,
			previewPrefix: selection.previewPrefix, previewSuffix: selection.previewSuffix,
			createdAt: new Date().toISOString()
		};
		doc.highlights.push(mark);
		this.recordHistory(selection.path, { type: "highlight-created", value: mark });
		await this.persist();
		window.getSelection()?.removeAllRanges();
		this.hideToolbar();
		this.queueRefresh();
	}

	openNewComment(selection) {
		if (!selection) return new Notice("请先在阅读视图中选中要关联的文字");
		new FloatingNoteModal(this, { path: selection.path, quote: selection.quote, selection }).open();
	}

	async saveComment(options, value) {
		const doc = this.documentFor(options.path);
		const root = document.querySelector(".markdown-preview-view .markdown-preview-sizer");
		const rootRect = root?.getBoundingClientRect();
		const scroll = root?.closest(".markdown-preview-view")?.scrollTop || 0;
		if (value.id) {
			const index = doc.comments.findIndex((item) => item.id === value.id);
			if (index !== -1) {
				const before = { ...doc.comments[index] };
				doc.comments[index] = value;
				this.recordHistory(options.path, { type: "comment-updated", id: value.id, before });
			}
		} else {
			const rect = options.selection?.rect;
			const note = {
				id: id(), text: value.text, color: value.color, fontSize: value.fontSize, fontFamily: "var(--font-text)",
				bold: false, italic: false, underline: false, strike: false,
				quote: options.quote || "", previewPrefix: options.selection?.previewPrefix || "", previewSuffix: options.selection?.previewSuffix || "",
				x: clamp((rect?.left || rootRect?.left || 30) - (rootRect?.left || 0) + 20, 12, 720),
				y: clamp((rect?.bottom || rootRect?.top || 30) - (rootRect?.top || 0) + scroll + 14, 12, 10000),
				width: 220, height: 88,
				autoWidth: true, autoHeight: true,
				createdAt: new Date().toISOString()
			};
			doc.comments.push(note);
			this.recordHistory(options.path, { type: "comment-created", value: note });
		}
		await this.persist();
		this.queueRefresh();
	}

	async removeComment(path, commentId) {
		const doc = this.documentFor(path);
		const index = doc.comments.findIndex((item) => item.id === commentId);
		if (index === -1) return;
		const [removed] = doc.comments.splice(index, 1);
		this.recordHistory(path, { type: "comment-deleted", value: removed, index });
		await this.persist();
		this.queueRefresh();
	}

	clearDecorations(root) {
		root.querySelectorAll(".sidecar-annotation-layer").forEach((el) => el.remove());
		Array.from(root.querySelectorAll(".sidecar-mark")).reverse().forEach((el) => el.replaceWith(...el.childNodes));
	}

	renderDocument(view, path) {
		const root = view.querySelector(".markdown-preview-sizer");
		if (!root) return;
		root.dataset.marginInkPath = path;
		this.clearDecorations(root);
		root.style.position = "relative";
		const doc = this.data.documents[path];
		if (!doc) return;
		for (const mark of doc.highlights || []) this.renderMark(root, path, mark);
		for (const note of doc.comments || []) {
			if (note.quote) this.renderMark(root, path, {
				id: `comment-anchor-${note.id}`, kind: "comment-anchor", color: "#fca5a5",
				quote: note.quote, previewPrefix: note.previewPrefix, previewSuffix: note.previewSuffix
			}, false);
		}
		this.renderComments(root, view, path, doc.comments || []);
	}

	textNodes(root) {
		const nodes = [];
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: (node) => {
				const parent = node.parentElement;
				if (!node.nodeValue || !parent || parent.closest(".sidecar-annotation-layer, pre, code, script, style")) return NodeFilter.FILTER_REJECT;
				return NodeFilter.FILTER_ACCEPT;
			}
		});
		while (walker.nextNode()) nodes.push(walker.currentNode);
		return nodes;
	}

	findMarkIndex(text, mark) {
		let from = 0, best = -1, bestScore = -1;
		while (true) {
			const index = text.indexOf(mark.quote, from);
			if (index === -1) break;
			const before = text.slice(Math.max(0, index - (mark.previewPrefix || "").length), index);
			const after = text.slice(index + mark.quote.length, index + mark.quote.length + (mark.previewSuffix || "").length);
			let score = 0;
			for (let i = 1; i <= before.length && i <= (mark.previewPrefix || "").length; i++) if (before.slice(-i) === mark.previewPrefix.slice(-i)) score = i;
			for (let i = 1; i <= after.length && i <= (mark.previewSuffix || "").length; i++) if (after.slice(0, i) === mark.previewSuffix.slice(0, i)) score += i;
			if (score > bestScore) { best = index; bestScore = score; }
			from = index + Math.max(1, mark.quote.length);
		}
		return best;
	}

	renderMark(root, path, mark, deletable = true) {
		const nodes = this.textNodes(root);
		const text = nodes.map((node) => node.nodeValue).join("");
		const start = this.findMarkIndex(text, mark);
		if (start < 0) return;
		const end = start + mark.quote.length;
		let cursor = 0;
		for (const node of nodes) {
			const length = node.nodeValue.length;
			const nodeStart = cursor;
			const nodeEnd = cursor + length;
			cursor = nodeEnd;
			if (nodeEnd <= start || nodeStart >= end || !node.parentNode) continue;
			const localStart = Math.max(0, start - nodeStart);
			const localEnd = Math.min(length, end - nodeStart);
			const before = node.nodeValue.slice(0, localStart);
			const selected = node.nodeValue.slice(localStart, localEnd);
			const after = node.nodeValue.slice(localEnd);
			const fragment = document.createDocumentFragment();
			if (before) fragment.append(document.createTextNode(before));
			const span = document.createElement("span");
			span.className = `sidecar-mark sidecar-mark--${mark.kind}`;
			span.style.setProperty("--sidecar-mark-color", validColor(mark.color));
			if (deletable) {
				span.dataset.sidecarId = mark.id;
				span.title = "右键可删除此标注";
				span.addEventListener("contextmenu", (event) => {
					event.preventDefault();
					const menu = new Menu();
					menu.addItem((item) => item
						.setTitle(mark.kind === "underline" ? "删除下划线" : "删除高亮")
						.setIcon("trash-2")
						.onClick(() => this.removeHighlight(path, mark.id)));
					menu.showAtMouseEvent(event);
				});
			}
			span.textContent = selected;
			fragment.append(span);
			if (after) fragment.append(document.createTextNode(after));
			node.parentNode.replaceChild(fragment, node);
		}
	}

	async removeHighlight(path, markId) {
		const doc = this.documentFor(path);
		const index = doc.highlights.findIndex((item) => item.id === markId);
		if (index === -1) return;
		const [removed] = doc.highlights.splice(index, 1);
		this.recordHistory(path, { type: "highlight-deleted", value: removed, index });
		await this.persist();
		this.queueRefresh();
		new Notice("已删除标注；可使用撤销恢复");
	}

	renderComments(root, view, path, comments) {
		if (!comments.length) return;
		const layer = document.createElement("div");
		layer.className = "sidecar-annotation-layer";
		root.appendChild(layer);
		for (const note of comments) {
			const box = document.createElement("article");
			box.className = "sidecar-floating-note";
			box.dataset.noteId = note.id;
			box.style.left = `${note.x || 12}px`;
			box.style.top = `${note.y || 12}px`;
			box.style.width = `${clamp(Number(note.width) || 220, 120, 900)}px`;
			box.style.height = `${clamp(Number(note.height) || 88, 46, 900)}px`;
			const content = document.createElement("div");
			content.className = "sidecar-floating-note__content";
			if (note.html) content.innerHTML = sanitizeNoteHtml(note.html);
			else content.textContent = note.text;
			content.contentEditable = "true";
			content.spellcheck = true;
			this.applyNoteStyle(box, content, note);
			content.addEventListener("focus", () => {
				content.dataset.originalText = note.text || "";
				content.dataset.originalHtml = note.html || "";
				content.dataset.originalWidth = String(note.width || 220);
				content.dataset.originalHeight = String(note.height || 88);
				this.showTextStyleToolbar(box, note, path, content);
			});
			content.addEventListener("input", () => this.fitNoteToText(box, content, note, root));
			content.addEventListener("blur", () => this.saveInlineCommentText(path, note, editableText(content), sanitizeNoteHtml(content.innerHTML), content.dataset.originalText || "", content.dataset.originalHtml || "", {
				width: Number(content.dataset.originalWidth) || 220,
				height: Number(content.dataset.originalHeight) || 88
			}));
			box.append(content);
			this.makeDraggable(box, note, path, root);
			for (const direction of ["n", "e", "s", "w", "ne", "se", "sw", "nw"]) {
				const handle = document.createElement("span");
				handle.className = `sidecar-floating-note__resize sidecar-floating-note__resize--${direction}`;
				handle.title = "调整文本框大小";
				this.makeResizable(handle, box, note, path, root, direction);
				box.appendChild(handle);
			}
			layer.appendChild(box);
			this.fitNoteToText(box, content, note, root);
		}
	}

	fitNoteToText(box, content, note, root) {
		if (note.autoWidth !== false) {
			const measurer = document.createElement("span");
			measurer.textContent = editableText(content) || " ";
			measurer.style.cssText = `position:absolute;visibility:hidden;white-space:pre;left:-10000px;font-family:${content.style.fontFamily || "inherit"};font-size:${getComputedStyle(content).fontSize};font-weight:${getComputedStyle(content).fontWeight};font-style:${getComputedStyle(content).fontStyle};`;
			box.appendChild(measurer);
			const desired = measurer.getBoundingClientRect().width + 20;
			measurer.remove();
			note.width = clamp(Math.ceil(desired), 120, Math.max(120, root.clientWidth - (Number(note.x) || 12) - 8));
			box.style.width = `${note.width}px`;
		}
		if (note.autoHeight !== false) {
			const originalHeight = content.style.height;
			content.style.height = "auto";
			note.height = clamp(Math.ceil(content.scrollHeight + 16), 46, 900);
			content.style.height = originalHeight;
			box.style.height = `${note.height}px`;
		}
	}

	async saveInlineCommentText(path, note, text, html, originalText, originalHtml, originalSize) {
		const nextText = text.trim();
		const nextHtml = html;
		if (!nextText || (nextText === originalText && nextHtml === originalHtml && note.width === originalSize.width && note.height === originalSize.height)) return;
		const doc = this.documentFor(path);
		const index = doc.comments.findIndex((item) => item.id === note.id);
		if (index === -1) return;
		this.recordHistory(path, { type: "comment-updated", id: note.id, before: { text: originalText, html: originalHtml, width: originalSize.width, height: originalSize.height } });
		doc.comments[index].text = nextText;
		doc.comments[index].html = nextHtml;
		note.text = nextText;
		note.html = nextHtml;
		await this.persist();
	}

	makeDraggable(box, note, path, root) {
		box.addEventListener("pointermove", (event) => {
			if (event.target instanceof Element && event.target.closest(".sidecar-floating-note__resize")) return;
			const rect = box.getBoundingClientRect();
			const edge = 9;
			const isBorder = event.clientX - rect.left < edge || rect.right - event.clientX < edge || event.clientY - rect.top < edge || rect.bottom - event.clientY < edge;
			box.style.cursor = isBorder ? "grab" : "";
		});
		box.addEventListener("pointerleave", () => { box.style.cursor = ""; });
		box.addEventListener("pointerdown", (event) => {
			if (event.target instanceof Element && event.target.closest(".sidecar-floating-note__resize")) return;
			const rect = box.getBoundingClientRect();
			const edge = 9;
			const isBorder = event.clientX - rect.left < edge || rect.right - event.clientX < edge || event.clientY - rect.top < edge || rect.bottom - event.clientY < edge;
			if (!isBorder) return;
			event.preventDefault();
			this.hideTextStyleToolbar();
			box.classList.add("is-dragging");
			const startX = event.clientX, startY = event.clientY, initialX = Number(note.x) || 12, initialY = Number(note.y) || 12;
			box.setPointerCapture(event.pointerId);
			const move = (moveEvent) => {
				note.x = clamp(initialX + moveEvent.clientX - startX, 8, Math.max(8, root.clientWidth - (Number(note.width) || 220) - 8));
				note.y = clamp(initialY + moveEvent.clientY - startY, 8, Math.max(8, root.scrollHeight - (Number(note.height) || 88) - 8));
				box.style.left = `${note.x}px`;
				box.style.top = `${note.y}px`;
			};
			const up = async () => {
				document.removeEventListener("pointermove", move);
				document.removeEventListener("pointerup", up);
				box.classList.remove("is-dragging");
				box.style.cursor = "";
				if (note.x !== initialX || note.y !== initialY) {
					this.recordHistory(path, { type: "comment-moved", id: note.id, before: { x: initialX, y: initialY } });
				}
				await this.persist();
				this.showTextStyleToolbar(box, note, path, box.querySelector(".sidecar-floating-note__content"));
			};
			document.addEventListener("pointermove", move);
			document.addEventListener("pointerup", up, { once: true });
		});
	}

	makeResizable(handle, box, note, path, root, direction) {
		handle.onpointerdown = (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.hideTextStyleToolbar();
			const startX = event.clientX, startY = event.clientY;
			const before = {
				x: Number(note.x) || 12, y: Number(note.y) || 12,
				width: Number(note.width) || 220, height: Number(note.height) || 88,
				autoWidth: note.autoWidth, autoHeight: note.autoHeight
			};
			handle.setPointerCapture(event.pointerId);
			const move = (moveEvent) => {
				const dx = moveEvent.clientX - startX, dy = moveEvent.clientY - startY;
				let left = before.x, top = before.y, right = before.x + before.width, bottom = before.y + before.height;
				if (direction.includes("w")) left += dx;
				if (direction.includes("e")) right += dx;
				if (direction.includes("n")) top += dy;
				if (direction.includes("s")) bottom += dy;
				left = clamp(left, 8, right - 120);
				top = clamp(top, 8, bottom - 46);
				right = clamp(right, left + 120, Math.max(left + 120, root.clientWidth - 8));
				bottom = clamp(bottom, top + 46, Math.max(top + 46, root.scrollHeight - 8));
				note.x = left; note.y = top; note.width = right - left; note.height = bottom - top;
				box.style.left = `${note.x}px`; box.style.top = `${note.y}px`;
				box.style.width = `${note.width}px`; box.style.height = `${note.height}px`;
			};
			const up = async () => {
				document.removeEventListener("pointermove", move);
				document.removeEventListener("pointerup", up);
				if (note.x !== before.x || note.y !== before.y || note.width !== before.width || note.height !== before.height) {
					if (direction.includes("w") || direction.includes("e")) note.autoWidth = false;
					if (direction.includes("n") || direction.includes("s")) note.autoHeight = false;
					this.recordHistory(path, { type: "comment-resized", id: note.id, before });
					await this.persist();
				}
				this.showTextStyleToolbar(box, note, path, box.querySelector(".sidecar-floating-note__content"));
			};
			document.addEventListener("pointermove", move);
			document.addEventListener("pointerup", up, { once: true });
		};
	}

	async exportActiveFile() {
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== "md") return new Notice("请先打开一篇 Markdown 笔记");
		const doc = this.data.documents[file.path];
		if (!doc || (!(doc.highlights || []).length && !(doc.comments || []).length)) return new Notice("这篇笔记还没有独立标注可导出");
		let content = await this.app.vault.read(file);
		const changes = [...(doc.highlights || [])].map((mark) => {
			let at = content.indexOf(mark.quote);
			if (at < 0) return null;
			const replacement = mark.kind === "underline"
				? `<u style="text-decoration-color: ${validColor(mark.color)}">${mark.quote}</u>`
				: `==${mark.quote}==`;
			return { at, quote: mark.quote, replacement };
		}).filter(Boolean).sort((a, b) => b.at - a.at);
		for (const change of changes) content = content.slice(0, change.at) + change.replacement + content.slice(change.at + change.quote.length);
		if (doc.comments?.length) {
			content += "\n\n---\n\n## 浮动标注\n\n";
			for (const note of doc.comments) content += `> [!note] ${note.quote ? `关联：${note.quote}` : "标注"}\n> ${note.text.replace(/\n/g, "\n> ")}\n\n`;
		}
		const parent = file.parent?.path ? `${file.parent.path}/` : "";
		const stem = `${parent}${file.basename}（带标注）`;
		let output = `${stem}.md`, index = 2;
		while (await this.app.vault.adapter.exists(output)) output = `${stem} ${index++}.md`;
		await this.app.vault.create(output, content);
		new Notice(`已导出新笔记：${output}`);
	}
};
