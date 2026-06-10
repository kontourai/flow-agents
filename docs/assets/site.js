const storageKey = "flow-agents-docs-theme";
const root = document.documentElement;
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
const mermaidApi = window.mermaid;

function currentTheme() {
  return root.dataset.theme === "dark" ? "dark" : "light";
}

function updateToggleLabels() {
  const label = currentTheme() === "dark" ? "Dark" : "Light";
  for (const element of document.querySelectorAll("[data-theme-label]")) {
    element.textContent = label;
  }
}

function setTheme(theme, persist = true) {
  root.dataset.theme = theme;
  if (persist) {
    localStorage.setItem(storageKey, theme);
  }
  updateToggleLabels();
}

function prepareMermaid() {
  for (const block of document.querySelectorAll("code.language-mermaid, code.mermaid")) {
    if (block.closest(".mermaid")) {
      continue;
    }
    const wrapper = document.createElement("div");
    wrapper.className = "mermaid";
    wrapper.textContent = block.textContent;
    const container = block.closest("pre");
    if (container) {
      container.replaceWith(wrapper);
    } else {
      block.replaceWith(wrapper);
    }
  }

  for (const diagram of document.querySelectorAll("div.mermaid, section.mermaid")) {
    if (!diagram.dataset.source) {
      diagram.dataset.source = diagram.textContent.trim();
    }
  }
}

async function renderMermaid() {
  if (!mermaidApi) {
    return;
  }
  const theme = currentTheme() === "dark" ? "dark" : "base";
  mermaidApi.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme,
    themeVariables: currentTheme() === "dark"
      ? {
          background: "#111824",
          primaryColor: "#16202d",
          primaryTextColor: "#eef3f8",
          primaryBorderColor: "#3d566e",
          lineColor: "#5cc4e0",
          secondaryColor: "#11303c",
          tertiaryColor: "#0a0e13",
          fontFamily: "IBM Plex Mono, monospace"
        }
      : {
          background: "#ffffff",
          primaryColor: "#ecebe4",
          primaryTextColor: "#101114",
          primaryBorderColor: "#9aa6b2",
          lineColor: "#1f6f88",
          secondaryColor: "#ddebef",
          tertiaryColor: "#f5f4ef",
          fontFamily: "IBM Plex Mono, monospace"
        }
  });

  const diagrams = Array.from(document.querySelectorAll(".mermaid")).filter((diagram) => diagram.dataset.source);
  diagrams.forEach((diagram, index) => {
    diagram.id = diagram.id || `mermaid-${index}`;
    diagram.removeAttribute("data-processed");
    diagram.textContent = diagram.dataset.source;
  });

  if (diagrams.length) {
    try {
      await mermaidApi.run({ nodes: diagrams });
    } catch (error) {
      console.error("Mermaid render failed", error);
      for (const diagram of diagrams) {
        diagram.textContent = diagram.dataset.source;
        diagram.classList.add("mermaid--error");
      }
    }
  }
}

function setupNavDrawer() {
  const toggle = document.querySelector("[data-nav-toggle]");
  const rail = document.getElementById("site-rail");
  const backdrop = document.querySelector("[data-nav-backdrop]");
  if (!toggle || !rail || !backdrop) {
    return;
  }
  const setOpen = (open) => {
    toggle.setAttribute("aria-expanded", String(open));
    rail.classList.toggle("open", open);
    backdrop.hidden = !open;
    document.body.classList.toggle("nav-open", open);
  };
  toggle.addEventListener("click", () => setOpen(toggle.getAttribute("aria-expanded") !== "true"));
  backdrop.addEventListener("click", () => setOpen(false));
  window.matchMedia("(min-width: 861px)").addEventListener("change", () => setOpen(false));
}

prepareMermaid();
updateToggleLabels();
setupNavDrawer();

for (const button of document.querySelectorAll("[data-theme-toggle]")) {
  button.addEventListener("click", async () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    setTheme(next);
    await renderMermaid();
  });
}

prefersDark.addEventListener("change", async (event) => {
  if (localStorage.getItem(storageKey)) {
    return;
  }
  root.dataset.theme = event.matches ? "dark" : "light";
  updateToggleLabels();
  await renderMermaid();
});

renderMermaid();
