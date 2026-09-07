type AtlNode = {
  type: string;
  content?: AtlNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
};

function textNode(text: string, marks: AtlNode["marks"] = []): AtlNode {
  return { type: "text", text, ...(marks.length ? { marks } : {}) };
}

function para(nodes: AtlNode[]): AtlNode {
  return { type: "paragraph", content: nodes };
}

function extractInlineMarks(text: string): AtlNode[] {
  const nodes: AtlNode[] = [];
  let remaining = text;

  while (remaining) {
    const codeMatch = remaining.match(/`([^`]+)`/);
    if (codeMatch) {
      if ((codeMatch.index ?? 0) > 0) {
        nodes.push(textNode(remaining.slice(0, codeMatch.index)));
      }
      nodes.push(textNode(codeMatch[1], [{ type: "code" }]));
      remaining = remaining.slice((codeMatch.index ?? 0) + codeMatch[0].length);
      continue;
    }

    const boldMatch = remaining.match(/\*\*([^*]+)\*\*/);
    if (boldMatch) {
      if ((boldMatch.index ?? 0) > 0) {
        nodes.push(textNode(remaining.slice(0, boldMatch.index)));
      }
      nodes.push(textNode(boldMatch[1], [{ type: "strong" }]));
      remaining = remaining.slice((boldMatch.index ?? 0) + boldMatch[0].length);
      continue;
    }

    if (remaining) nodes.push(textNode(remaining));
    break;
  }

  return nodes;
}

export function mdToAdf(md: string): AtlNode[] {
  const lines = md.split("\n");
  const nodes: AtlNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code fence
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || "text";
      const codeLines: string[] = [];
      while (++i < lines.length && !lines[i].startsWith("```")) codeLines.push(lines[i]);
      nodes.push({
        type: "codeBlock",
        attrs: { language: lang },
        content: [textNode(codeLines.join("\n"))],
      });
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      nodes.push({
        type: "heading",
        attrs: { level },
        content: extractInlineMarks(headingMatch[2]),
      });
      i++;
      continue;
    }

    // Bullet list
    if (/^\s*[-*]\s/.test(line)) {
      const items: AtlNode[] = [];
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) {
        items.push({
          type: "listItem",
          content: [para(extractInlineMarks(lines[i].replace(/^\s*[-*]\s/, "")))],
        });
        i++;
      }
      nodes.push({ type: "bulletList", content: items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s/.test(line)) {
      const items: AtlNode[] = [];
      while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
        items.push({
          type: "listItem",
          content: [para(extractInlineMarks(lines[i].replace(/^\s*\d+\.\s/, "")))],
        });
        i++;
      }
      nodes.push({ type: "orderedList", content: items });
      continue;
    }

    // Paragraph — accumulate until blank or structural line
    if (line.trim() === "") {
      i++;
      continue;
    }
    const isStructural =
      /^#{1,6}\s/.test(line) ||
      line.startsWith("```") ||
      /^\s*[-*]\s/.test(line) ||
      /^\s*\d+\.\s/.test(line) ||
      /^\s*[-*#* ]+$/.test(line);
    if (!isStructural) {
      const paraLines: string[] = [line];
      while (
        i + 1 < lines.length &&
        lines[i + 1].trim() !== "" &&
        !/^#{1,6}\s/.test(lines[i + 1]) &&
        !lines[i + 1].startsWith("```") &&
        !/^\s*[-*]\s/.test(lines[i + 1]) &&
        !/^\s*\d+\.\s/.test(lines[i + 1]) &&
        !/^\s*[-*#* ]+$/.test(lines[i + 1])
      ) {
        i++;
        paraLines.push(lines[i]);
      }
      nodes.push(para(extractInlineMarks(paraLines.join(" "))));
      i++;
      continue;
    }

    i++;
  }

  return nodes;
}
