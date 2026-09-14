/** Minimal markdown → safe HTML for assistant transcript (Continue-like). */
(function (global) {
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function inlineFormat(text) {
    let s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, "<code class=\"md-inline\">$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" title="$2">$1</a>');
    return s;
  }

  function renderMarkdown(src) {
    const raw = String(src || "");
    if (!raw.trim()) return "";

    const parts = [];
    const fence = /```([\w+-]*)\n?([\s\S]*?)```/g;
    let last = 0;
    let m;
    while ((m = fence.exec(raw))) {
      if (m.index > last) {
        parts.push({ type: "md", text: raw.slice(last, m.index) });
      }
      parts.push({ type: "code", lang: m[1] || "", text: m[2].replace(/\n$/, "") });
      last = m.index + m[0].length;
    }
    if (last < raw.length) parts.push({ type: "md", text: raw.slice(last) });

    return parts
      .map(function (p) {
        if (p.type === "code") {
          return (
            '<pre class="md-code"><code>' +
            escapeHtml(p.text) +
            "</code></pre>"
          );
        }
        return renderBlocks(p.text);
      })
      .join("");
  }

  function renderBlocks(text) {
    const lines = text.split(/\n/);
    const out = [];
    let i = 0;
    let para = [];
    let listType = null;
    let listItems = [];

    function flushPara() {
      if (!para.length) return;
      out.push("<p>" + inlineFormat(para.join(" ")) + "</p>");
      para = [];
    }

    function flushList() {
      if (!listType) return;
      const tag = listType === "ol" ? "ol" : "ul";
      out.push(
        "<" +
          tag +
          " class=\"md-list\">" +
          listItems.map(function (li) {
            return "<li>" + inlineFormat(li) + "</li>";
          }).join("") +
          "</" +
          tag +
          ">"
      );
      listType = null;
      listItems = [];
    }

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        flushPara();
        flushList();
        i++;
        continue;
      }

      const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
      if (heading) {
        flushPara();
        flushList();
        const level = heading[1].length;
        out.push(
          "<h" + level + " class=\"md-h\">" + inlineFormat(heading[2]) + "</h" + level + ">"
        );
        i++;
        continue;
      }

      const ul = /^[-*]\s+(.+)$/.exec(trimmed);
      if (ul) {
        flushPara();
        if (listType && listType !== "ul") flushList();
        listType = "ul";
        listItems.push(ul[1]);
        i++;
        continue;
      }

      const ol = /^\d+\.\s+(.+)$/.exec(trimmed);
      if (ol) {
        flushPara();
        if (listType && listType !== "ol") flushList();
        listType = "ol";
        listItems.push(ol[1]);
        i++;
        continue;
      }

      if (trimmed.startsWith("> ")) {
        flushPara();
        flushList();
        out.push("<blockquote class=\"md-quote\">" + inlineFormat(trimmed.slice(2)) + "</blockquote>");
        i++;
        continue;
      }

      flushList();
      para.push(trimmed);
      i++;
    }
    flushPara();
    flushList();
    return out.join("");
  }

  global.ForgeMarkdown = { render: renderMarkdown, escapeHtml: escapeHtml };
})(typeof window !== "undefined" ? window : globalThis);
