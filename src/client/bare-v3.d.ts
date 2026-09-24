// bare-v3 ships plain JS without typings — just the surface AssistantMarkdown uses.
declare module '@livx.cc/bare-v3/elements/markdown-stream' {
  export class MarkdownStream {
    constructor(options: { Marked: unknown; sanitize: (html: string) => string; code?: (text: string, lang: string) => string });
    buf: string;
    attach(el: HTMLElement): this;
    detach(): void;
    push(chunk: string): void;
    end(): void;
    toHtml(src: string): string;
  }
  export function codeBlock(text: string, lang: string): string;
  export function promptGuide(options?: object): string;
}
declare module '@livx.cc/bare-v3/css';
