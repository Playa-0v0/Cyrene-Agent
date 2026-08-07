import "../ui/base.css";
import "./notebook.css";
import "../ui/theme";

declare global {
  interface Window {
    sidebar?: {
      readSharedNotebook: () => Promise<string>;
      openSharedNotebook: () => Promise<boolean>;
      getNotebookEntries?: () => Promise<any[]>;
      addNotebookEntry?: (options: any) => Promise<{ ok: boolean; entry?: any }>;
      updateNotebookEntry?: (id: string, content: string, title?: string) => Promise<{ ok: boolean }>;
      deleteNotebookEntry?: (id: string) => Promise<{ ok: boolean }>;
      onSharedNotebookChanged?: (callback: () => void) => () => void;
    };
  }
}

const bookContainer = document.getElementById("book-container");
const leftPageContent = document.getElementById("left-page-content");
const rightPageContent = document.getElementById("right-page-content");
const leftPageNum = document.getElementById("left-page-num");
const rightPageNum = document.getElementById("right-page-num");

const prevPageBtn = document.getElementById("prev-page-btn") as HTMLButtonElement | null;
const nextPageBtn = document.getElementById("next-page-btn") as HTMLButtonElement | null;
const openNotebookBtn = document.getElementById("open-notebook-btn");
const addNoteBtn = document.getElementById("add-note-btn");
const chaptersListContainer = document.getElementById("chapters-list-container");
const searchInput = document.getElementById("notebook-search-input") as HTMLInputElement | null;
const categoryTabsContainer = document.getElementById("category-tabs-container");

// Modal Elements
const noteModal = document.getElementById("note-modal");
const modalCloseBtn = document.getElementById("modal-close-btn");
const modalCancelBtn = document.getElementById("modal-cancel-btn");
const modalSaveBtn = document.getElementById("modal-save-btn");
const modalTitle = document.getElementById("modal-title");
const noteTitleInput = document.getElementById("note-title-input") as HTMLInputElement | null;
const noteCategorySelect = document.getElementById("note-category-select") as HTMLSelectElement | null;
const noteContentInput = document.getElementById("note-content-input") as HTMLTextAreaElement | null;
const noteTagsInput = document.getElementById("note-tags-input") as HTMLInputElement | null;

let editingEntryId: string | null = null;
let rawMarkdown = "";
let pages: string[] = [];
let currentPageIndex = 0;
let activeCategory = "all";
let searchQuery = "";

const singlePageMedia = window.matchMedia("(max-width: 760px)");

function pageStep(): number {
  return singlePageMedia.matches ? 1 : 2;
}

function parseMarkdown(md: string): string {
  let html = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const lines = html.split("\n");
  let resultLines: string[] = [];
  let inList = false;

  for (let line of lines) {
    let trimmed = line.trim();

    // Preserve comment ID for action buttons
    const idMatch = line.match(/&lt;!--\s*cyrene-discord:([a-f0-9]+)\s*--&gt;/i);
    const entryId = idMatch ? idMatch[1] : "";

    line = line.replace(/\s*&lt;!--\s*cyrene-discord[^]*?--&gt;/g, "");
    trimmed = line.trim();

    if (trimmed.startsWith("&gt;")) {
      const content = trimmed.substring(4).trim();
      line = `<blockquote>${content}</blockquote>`;
    } else if (trimmed.startsWith("###")) {
      line = `<h3>${trimmed.substring(3).trim()}</h3>`;
    } else if (trimmed.startsWith("##")) {
      line = `<h2>${trimmed.substring(2).trim()}</h2>`;
    } else if (trimmed.startsWith("#")) {
      line = `<h1>${trimmed.substring(1).trim()}</h1>`;
    } else if (trimmed === "---") {
      line = `<hr />`;
    } else if (trimmed.startsWith("*") || trimmed.startsWith("-")) {
      const content = trimmed.substring(1).trim();
      const actionButtons = entryId
        ? `<span class="entry-actions"><button type="button" class="btn-edit-entry" data-id="${entryId}" title="編輯">✏️</button><button type="button" class="btn-delete-entry" data-id="${entryId}" title="刪除">🗑️</button></span>`
        : "";
      line = `<li class="notebook-entry-item">${content} ${actionButtons}</li>`;
      if (!inList) {
        line = `<ul class="notebook-entry-list">` + line;
        inList = true;
      }
    } else {
      if (inList) {
        resultLines[resultLines.length - 1] += `</ul>`;
        inList = false;
      }
    }

    line = line.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    line = line.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    
    resultLines.push(line);
  }

  if (inList && resultLines.length > 0) {
    resultLines[resultLines.length - 1] += `</ul>`;
  }

  return resultLines.join("\n");
}

function splitIntoPages(text: string): string[] {
  const resultPages: string[] = [];
  const cleanText = text.trim();
  if (!cleanText) return [];

  const firstHashIndex = cleanText.indexOf("###");
  if (firstHashIndex === -1) {
    resultPages.push(cleanText);
    return resultPages;
  }

  const intro = cleanText.substring(0, firstHashIndex).trim();
  if (intro) {
    resultPages.push(intro);
  }

  const rest = cleanText.substring(firstHashIndex);
  const sections = rest.split(/(?=###)/g);
  for (const sec of sections) {
    const cleanSec = sec.trim();
    if (cleanSec) {
      // Filter section by active category or search query
      if (shouldIncludeSection(cleanSec)) {
        resultPages.push(cleanSec);
      }
    }
  }

  return resultPages;
}

function shouldIncludeSection(sectionText: string): boolean {
  if (activeCategory !== "all" && !matchesCategory(sectionText, activeCategory)) {
    return false;
  }
  if (searchQuery && !sectionText.toLowerCase().includes(searchQuery)) {
    return false;
  }
  return true;
}

function matchesCategory(sectionText: string, category: string): boolean {
  if (category === "all") return true;

  // Direct emoji/string match
  if (sectionText.includes(category)) return true;

  const catName = category.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "").trim();

  if (catName === "日誌" || catName === "陪伴" || category.includes("🌸")) {
    return /🌸|陪伴|日誌|回憶|愛意|足跡|昔漣/i.test(sectionText);
  }
  if (catName === "聽歌" || category.includes("🎵")) {
    return /🎵|聽歌|音樂|樂章|樂聲|旋律|歌|曲子/i.test(sectionText);
  }
  if (catName === "學習" || catName === "筆記" || category.includes("📝")) {
    return /📝|筆記|學習|物理|動力學|考試|成績|測驗|專注|做完|程式/i.test(sectionText);
  }
  if (catName === "悄悄話" || category.includes("💖")) {
    return /💖|悄悄話|心事|私語|愛意|秘密|牽掛|幸福/i.test(sectionText);
  }

  return sectionText.includes(catName);
}

function getChapterTitle(content: string, index: number): string {
  if (index === 0) return "第一章 · 起始前言";
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("###")) {
      return trimmed.replace(/^###\s*/, "").replace(/📅\s*/, "").trim();
    }
  }
  return `第 ${index + 1} 章`;
}

function buildChaptersSidebar() {
  if (!chaptersListContainer) return;
  chaptersListContainer.innerHTML = "";

  pages.forEach((pageContent, idx) => {
    const title = getChapterTitle(pageContent, idx);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "chapter-item";
    item.textContent = title;
    item.setAttribute("data-page-index", String(idx));
    
    item.addEventListener("click", () => {
      currentPageIndex = singlePageMedia.matches ? idx : Math.floor(idx / 2) * 2;
      updatePageDisplay();
    });

    chaptersListContainer.appendChild(item);
  });
}

function attachEntryActionListeners(container: HTMLElement) {
  container.querySelectorAll(".btn-delete-entry").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = (btn as HTMLElement).getAttribute("data-id");
      if (id && window.sidebar?.deleteNotebookEntry) {
        if (confirm("確定要刪除這條共同筆記嗎？")) {
          await window.sidebar.deleteNotebookEntry(id);
          void init();
        }
      }
    });
  });

  container.querySelectorAll(".btn-edit-entry").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = (btn as HTMLElement).getAttribute("data-id");
      if (id) {
        openEditModal(id);
      }
    });
  });
}

function updatePageDisplay() {
  if (!leftPageContent || !rightPageContent || !leftPageNum || !rightPageNum) return;

  // Left Page
  if (currentPageIndex < pages.length) {
    leftPageContent.innerHTML = parseMarkdown(pages[currentPageIndex]);
    leftPageNum.textContent = String(currentPageIndex + 1);
    attachEntryActionListeners(leftPageContent);
  } else {
    leftPageContent.innerHTML = `
      <div class="empty-page-tip">
        <span>📖</span>
        <span>期待我們寫下更多故事...</span>
      </div>
    `;
    leftPageNum.textContent = String(currentPageIndex + 1);
  }

  // Right Page
  const rightIndex = currentPageIndex + 1;
  if (rightIndex < pages.length) {
    rightPageContent.innerHTML = parseMarkdown(pages[rightIndex]);
    rightPageNum.textContent = String(rightIndex + 1);
    attachEntryActionListeners(rightPageContent);
  } else {
    rightPageContent.innerHTML = `
      <div class="empty-page-tip">
        <span>🌸</span>
        <span>期待我們寫下更多故事...</span>
      </div>
    `;
    rightPageNum.textContent = String(rightIndex + 1);
  }

  if (prevPageBtn) prevPageBtn.disabled = (currentPageIndex === 0);
  if (nextPageBtn) nextPageBtn.disabled = (currentPageIndex + pageStep() >= pages.length);

  const items = chaptersListContainer?.querySelectorAll(".chapter-item");
  if (items) {
    items.forEach((item) => {
      const idx = Number(item.getAttribute("data-page-index"));
      const isVisible = idx === currentPageIndex || (!singlePageMedia.matches && idx === currentPageIndex + 1);
      if (isVisible) {
        item.classList.add("active");
      } else {
        item.classList.remove("active");
      }
    });
  }
}

function turnPage(direction: "next" | "prev") {
  if (!bookContainer) return;

  const animationClass = direction === "next" ? "flipping-next" : "flipping-prev";
  bookContainer.classList.add(animationClass);

  setTimeout(() => {
    const step = pageStep();
    if (direction === "next") {
      if (currentPageIndex + step < pages.length) {
        currentPageIndex += step;
      }
    } else {
      if (currentPageIndex - step >= 0) {
        currentPageIndex -= step;
      }
    }
    updatePageDisplay();
    bookContainer.classList.remove(animationClass);
  }, 350);
}

prevPageBtn?.addEventListener("click", () => turnPage("prev"));
nextPageBtn?.addEventListener("click", () => turnPage("next"));

document.getElementById("book-left-page")?.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.tagName === "A" || target.tagName === "BUTTON" || target.closest(".entry-actions")) return;
  if (currentPageIndex > 0) turnPage("prev");
});

document.getElementById("book-right-page")?.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.tagName === "A" || target.tagName === "BUTTON" || target.closest(".entry-actions")) return;
  if (currentPageIndex + pageStep() < pages.length) turnPage("next");
});

openNotebookBtn?.addEventListener("click", () => {
  window.sidebar?.openSharedNotebook();
});

// Category Tab Switching
categoryTabsContainer?.querySelectorAll(".cat-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    categoryTabsContainer.querySelectorAll(".cat-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    activeCategory = tab.getAttribute("data-cat") || "all";
    pages = splitIntoPages(rawMarkdown);
    currentPageIndex = 0;
    buildChaptersSidebar();
    updatePageDisplay();
  });
});

// Search Input Listener
searchInput?.addEventListener("input", () => {
  searchQuery = searchInput.value.trim().toLowerCase();
  pages = splitIntoPages(rawMarkdown);
  currentPageIndex = 0;
  buildChaptersSidebar();
  updatePageDisplay();
});

// Modal Logic
function openAddModal() {
  editingEntryId = null;
  if (modalTitle) modalTitle.textContent = "✍️ 新增共同筆記";
  if (noteTitleInput) noteTitleInput.value = "";
  if (noteContentInput) noteContentInput.value = "";
  if (noteTagsInput) noteTagsInput.value = "";
  noteModal?.classList.remove("hidden");
}

function openEditModal(id: string) {
  editingEntryId = id;
  if (modalTitle) modalTitle.textContent = "✏️ 編輯共同筆記";
  noteModal?.classList.remove("hidden");
}

function closeModal() {
  noteModal?.classList.add("hidden");
}

addNoteBtn?.addEventListener("click", openAddModal);
modalCloseBtn?.addEventListener("click", closeModal);
modalCancelBtn?.addEventListener("click", closeModal);

modalSaveBtn?.addEventListener("click", async () => {
  const title = noteTitleInput?.value.trim() || "無標題";
  const category = (noteCategorySelect?.value as any) || "🌸 陪伴";
  const content = noteContentInput?.value.trim() || "";
  const tagsStr = noteTagsInput?.value.trim() || "";
  const tags = tagsStr ? tagsStr.split(",").map((s) => s.trim()).filter(Boolean) : [];

  if (!content) {
    alert("請輸入筆記內容");
    return;
  }

  if (editingEntryId) {
    if (window.sidebar?.updateNotebookEntry) {
      await window.sidebar.updateNotebookEntry(editingEntryId, content, title);
    }
  } else {
    if (window.sidebar?.addNotebookEntry) {
      await window.sidebar.addNotebookEntry({
        title,
        content,
        category,
        tags,
      });
    }
  }

  closeModal();
  void init();
});

async function init() {
  if (window.sidebar?.readSharedNotebook) {
    rawMarkdown = await window.sidebar.readSharedNotebook();
    pages = splitIntoPages(rawMarkdown);
    
    buildChaptersSidebar();

    currentPageIndex = singlePageMedia.matches
      ? Math.max(0, pages.length - 1)
      : Math.floor(Math.max(0, pages.length - 1) / 2) * 2;
    updatePageDisplay();
  }
}

void init();
singlePageMedia.addEventListener("change", () => {
  if (!singlePageMedia.matches) currentPageIndex = Math.floor(currentPageIndex / 2) * 2;
  updatePageDisplay();
});
window.sidebar?.onSharedNotebookChanged?.(() => {
  void init();
});
