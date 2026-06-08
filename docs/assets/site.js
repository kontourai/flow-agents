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
          background: "#171c18",
          primaryColor: "#222920",
          primaryTextColor: "#fff8eb",
          primaryBorderColor: "#53624f",
          lineColor: "#88e5c9",
          secondaryColor: "#16382f",
          tertiaryColor: "#0c100d",
          fontFamily: "IBM Plex Mono, monospace"
        }
      : {
          background: "#fbfdf8",
          primaryColor: "#e7eee7",
          primaryTextColor: "#101511",
          primaryBorderColor: "#9cad99",
          lineColor: "#0b6f5c",
          secondaryColor: "#dceee6",
          tertiaryColor: "#f4f7f3",
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

prepareMermaid();
updateToggleLabels();

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
