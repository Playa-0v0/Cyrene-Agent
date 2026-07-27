import "../ui/base.css";
import "./notebook.css";
import "../ui/theme";

// Expose sidebars types on Window
declare global {
  interface Window {
    sidebar?: {
      readSharedNotebook: () => Promise<string>;
      openSharedNotebook: () => Promise<boolean>;
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
const chaptersListContainer = document.getElementById("chapters-list-container");

let pages: string[] = [];
let currentPageIndex = 0; // 單頁模式逐頁遞增；雙頁模式維持偶數索引。
const singlePageMedia = window.matchMedia("(max-width: 760px)");

function pageStep(): number {
  return singlePageMedia.matches ? 1 : 2;
}

function parseMarkdown(md: string): string {
  // Escape HTML to prevent injection
  let html = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const lines = html.split("\n");
  let resultLines: string[] = [];
  let inList = false;

  for (let line of lines) {
    let trimmed = line.trim();

    // 自動日誌使用的去重標記不顯示在書頁上。
    if (/^&lt;!--\s*cyrene-discord[^]*--&gt;$/.test(trimmed)) {
      resultLines.push("");
      continue;
    }
    line = line.replace(/\s*&lt;!--\s*cyrene-discord[^]*?--&gt;/g, "");
    trimmed = line.trim();

    // Check blockquotes
    if (trimmed.startsWith("&gt;")) {
      const content = trimmed.substring(4).trim();
      line = `<blockquote>${content}</blockquote>`;
    }
    // Check headings
    else if (trimmed.startsWith("###")) {
      line = `<h3>${trimmed.substring(3).trim()}</h3>`;
    } else if (trimmed.startsWith("##")) {
      line = `<h2>${trimmed.substring(2).trim()}</h2>`;
    } else if (trimmed.startsWith("#")) {
      line = `<h1>${trimmed.substring(1).trim()}</h1>`;
    }
    // Check divider
    else if (trimmed === "---") {
      line = `<hr />`;
    }
    // Check list item
    else if (trimmed.startsWith("*") || trimmed.startsWith("-")) {
      const content = trimmed.substring(1).trim();
      line = `<li>${content}</li>`;
      if (!inList) {
        line = `<ul>` + line;
        inList = true;
      }
    } else {
      // If we were in a list and line is not list, close it
      if (inList) {
        resultLines[resultLines.length - 1] += `</ul>`;
        inList = false;
      }
    }

    // Bold text **word**
    line = line.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // 僅允許自動日誌產生的 http(s) 連結。
    line = line.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    
    resultLines.push(line);
  }

  // Final check to close open list
  if (inList && resultLines.length > 0) {
    resultLines[resultLines.length - 1] += `</ul>`;
  }

  return resultLines.join("\n");
}

function splitIntoPages(text: string): string[] {
  const resultPages: string[] = [];
  const cleanText = text.trim();
  if (!cleanText) return [];

  // Find first entry heading
  const firstHashIndex = cleanText.indexOf("###");
  if (firstHashIndex === -1) {
    resultPages.push(cleanText);
    return resultPages;
  }

  // Page 0 (Cover / Intro) is everything before the first "###"
  const intro = cleanText.substring(0, firstHashIndex).trim();
  if (intro) {
    resultPages.push(intro);
  }

  // Split rest of the document by lookahead "###" to preserve headings
  const rest = cleanText.substring(firstHashIndex);
  const sections = rest.split(/(?=###)/g);
  for (const sec of sections) {
    const cleanSec = sec.trim();
    if (cleanSec) {
      resultPages.push(cleanSec);
    }
  }

  return resultPages;
}

function getChapterTitle(content: string, index: number): string {
  if (index === 0) return "第一章 · 起始前言";
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("###")) {
      // Strip hashes and clean up
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
      // 窄畫面逐頁閱讀；寬畫面則翻到包含該章節的雙頁。
      currentPageIndex = singlePageMedia.matches ? idx : Math.floor(idx / 2) * 2;
      updatePageDisplay();
    });

    chaptersListContainer.appendChild(item);
  });
}

function updatePageDisplay() {
  if (!leftPageContent || !rightPageContent || !leftPageNum || !rightPageNum) return;

  // Left Page
  if (currentPageIndex < pages.length) {
    leftPageContent.innerHTML = parseMarkdown(pages[currentPageIndex]);
    leftPageNum.textContent = String(currentPageIndex + 1);
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
  } else {
    rightPageContent.innerHTML = `
      <div class="empty-page-tip">
        <span>🌸</span>
        <span>期待我們寫下更多故事...</span>
      </div>
    `;
    rightPageNum.textContent = String(rightIndex + 1);
  }

  // Button States
  if (prevPageBtn) prevPageBtn.disabled = (currentPageIndex === 0);
  if (nextPageBtn) nextPageBtn.disabled = (currentPageIndex + pageStep() >= pages.length);

  // 更新左側 sidebar 章節的高亮狀態
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
  }, 350); // Match CSS transition duration
}

prevPageBtn?.addEventListener("click", () => turnPage("prev"));
nextPageBtn?.addEventListener("click", () => turnPage("next"));

// 點擊左頁面邊角也能往前翻頁
document.getElementById("book-left-page")?.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).tagName === "A" || (e.target as HTMLElement).tagName === "BUTTON") return;
  if (currentPageIndex > 0) turnPage("prev");
});

// 點擊右頁面邊角也能往後翻頁
document.getElementById("book-right-page")?.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).tagName === "A" || (e.target as HTMLElement).tagName === "BUTTON") return;
  if (currentPageIndex + pageStep() < pages.length) turnPage("next");
});

openNotebookBtn?.addEventListener("click", () => {
  window.sidebar?.openSharedNotebook();
});

async function init() {
  if (window.sidebar?.readSharedNotebook) {
    const text = await window.sidebar.readSharedNotebook();
    pages = splitIntoPages(text);
    
    // 建立左側章節清單
    buildChaptersSidebar();

    // 開啟時自動翻到最新紀錄；雙頁模式對齊偶數頁。
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
