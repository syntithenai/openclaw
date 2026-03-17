import DOMPurify from "dompurify";

type MermaidModule = {
  default: {
    initialize: (config: Record<string, unknown>) => void;
    render: (
      id: string,
      text: string,
    ) => Promise<{ svg: string; bindFunctions?: (el: Element) => void }>;
  };
};

const chartStyles = `
  :host {
    display: block;
    margin: 0.5rem 0;
  }
  .shell {
    border: 1px solid var(--chat-border, #3f3f46);
    border-radius: 10px;
    background: var(--chat-code-bg, #18181b);
    padding: 0.75rem;
    overflow: auto;
  }
  .label {
    margin-bottom: 0.5rem;
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--chat-meta, #a1a1aa);
  }
  .error {
    color: var(--chat-danger, #f87171);
    white-space: pre-wrap;
  }
`;

let mermaidRef: MermaidModule["default"] | null = null;
let mermaidInit = false;
let renderCounter = 0;

async function getMermaid() {
  if (mermaidRef) {
    return mermaidRef;
  }
  const mod = (await import("mermaid")) as MermaidModule;
  mermaidRef = mod.default;
  if (!mermaidInit) {
    mermaidRef.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
    });
    mermaidInit = true;
  }
  return mermaidRef;
}

class OpenClawMermaidChart extends HTMLElement {
  private sourceText = "";
  private shadowRootRef: ShadowRoot;

  constructor() {
    super();
    this.shadowRootRef = this.attachShadow({ mode: "open" });
  }

  set source(value: string) {
    const next = String(value ?? "");
    if (next === this.sourceText) {
      return;
    }
    this.sourceText = next;
    void this.renderChart();
  }

  get source() {
    return this.sourceText;
  }

  connectedCallback() {
    void this.renderChart();
  }

  private async renderChart() {
    const source = this.sourceText.trim();
    if (!source) {
      this.shadowRootRef.innerHTML = "";
      return;
    }

    this.shadowRootRef.innerHTML = `<style>${chartStyles}</style><div class="shell"><div class="label">Diagram</div><div class="content"></div></div>`;
    const container = this.shadowRootRef.querySelector(".content");
    if (!container) {
      return;
    }

    try {
      const mermaid = await getMermaid();
      const result = await mermaid.render(`oc-mermaid-${++renderCounter}`, source);
      const sanitized = DOMPurify.sanitize(result.svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
      });
      container.innerHTML = sanitized;
      if (typeof result.bindFunctions === "function") {
        result.bindFunctions(container);
      }
    } catch {
      container.innerHTML = `<pre class="error">Unable to render diagram.\n\n${source}</pre>`;
    }
  }
}

if (!customElements.get("oc-mermaid-chart")) {
  customElements.define("oc-mermaid-chart", OpenClawMermaidChart);
}
