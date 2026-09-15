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

  /** Split a GFM table row into cells (handles leading/trailing pipes). */
  function splitTableRow(line) {
    let s = String(line || "").trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map(function (c) {
      return c.trim();
    });
  }

  function isTableSeparator(line) {
    const cells = splitTableRow(line);
    if (!cells.length) return false;
    // GFM wants 3+ dashes; models often emit |-|-| — accept 1+.
    return cells.every(function (c) {
      return /^:?-+:?$/.test(c.replace(/\s+/g, ""));
    });
  }

  function looksLikeTableRow(line) {
    const t = String(line || "").trim();
    if (!t.includes("|")) return false;
    // Avoid treating plain prose with a single pipe as a table.
    return /^\|?.+\|.+\|?$/.test(t);
  }

  function alignmentFromSeparator(cell) {
    const c = cell.replace(/\s+/g, "");
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  }

  function renderTable(headerLine, sepLine, bodyLines) {
    const headers = splitTableRow(headerLine);
    const aligns = splitTableRow(sepLine).map(alignmentFromSeparator);
    const rows = bodyLines.map(splitTableRow);

    let html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
    headers.forEach(function (h, i) {
      const align = aligns[i] ? ' style="text-align:' + aligns[i] + '"' : "";
      html += "<th" + align + ">" + inlineFormat(h) + "</th>";
    });
    html += "</tr></thead><tbody>";
    rows.forEach(function (cells) {
      html += "<tr>";
      for (let i = 0; i < headers.length; i++) {
        const align = aligns[i] ? ' style="text-align:' + aligns[i] + '"' : "";
        html += "<td" + align + ">" + inlineFormat(cells[i] || "") + "</td>";
      }
      html += "</tr>";
    });
    html += "</tbody></table></div>";
    return html;
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

      // GFM table: header + separator (|---|---|) + body rows
      if (
        looksLikeTableRow(trimmed) &&
        i + 1 < lines.length &&
        isTableSeparator(lines[i + 1].trim())
      ) {
        flushPara();
        flushList();
        const headerLine = trimmed;
        const sepLine = lines[i + 1].trim();
        i += 2;
        const body = [];
        while (i < lines.length && looksLikeTableRow(lines[i].trim())) {
          body.push(lines[i].trim());
          i++;
        }
        out.push(renderTable(headerLine, sepLine, body));
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
