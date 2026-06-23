import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false
});

export function renderMarkdownFragment(markdownSource) {
  return markdown.render(String(markdownSource ?? ""));
}
