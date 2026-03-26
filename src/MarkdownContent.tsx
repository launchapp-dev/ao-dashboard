import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

interface Props {
  content: string;
  className?: string;
}

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), "details", "summary"],
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code || []), ["className"]],
    pre: [...(defaultSchema.attributes?.pre || []), ["className"]],
    span: [...(defaultSchema.attributes?.span || []), ["className"]],
    div: [...(defaultSchema.attributes?.div || []), ["className"]],
    input: [
      ...(defaultSchema.attributes?.input || []),
      ["type"],
      ["checked"],
      ["disabled"],
    ],
    img: [
      ...(defaultSchema.attributes?.img || []),
      ["src"],
      ["alt"],
      ["title"],
    ],
    a: [
      ...(defaultSchema.attributes?.a || []),
      ["href"],
      ["title"],
    ],
  },
};

export function MarkdownContent({ content, className }: Props) {
  return (
    <div className={cn("log-markdown text-[11px] leading-5 text-foreground", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, sanitizeSchema],
        ]}
        components={{
          h1: ({ children }) => <h1 className="mt-3 mb-2 text-lg font-semibold text-foreground first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-3 mb-2 text-base font-semibold text-foreground first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-3 mb-2 text-sm font-semibold text-foreground first:mt-0">{children}</h3>,
          h4: ({ children }) => <h4 className="mt-2 mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</h4>,
          h5: ({ children }) => <h5 className="mt-2 mb-1 text-[11px] font-semibold text-foreground">{children}</h5>,
          h6: ({ children }) => <h6 className="mt-2 mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</h6>,
          p: ({ children }) => <p className="my-2 whitespace-pre-wrap break-words first:mt-0 last:mb-0">{children}</p>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="break-all text-primary underline underline-offset-2 hover:text-primary/80">
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 marker:text-muted-foreground">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-muted-foreground">{children}</ol>,
          li: ({ children }) => <li className="break-words">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-primary/40 bg-card/45 px-3 py-2 text-muted-foreground">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-border/70" />,
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded border border-border/70">
              <table className="min-w-full border-collapse text-left">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-card/70">{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => <tr className="border-b border-border/60 last:border-b-0">{children}</tr>,
          th: ({ children }) => <th className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</th>,
          td: ({ children }) => <td className="px-3 py-2 align-top whitespace-pre-wrap break-words">{children}</td>,
          pre: ({ children }) => (
            <pre className="my-3 overflow-x-auto rounded border border-border/70 bg-background px-3 py-2 text-[11px] leading-5 text-foreground">
              {children}
            </pre>
          ),
          code: ({ className: codeClassName, children }) => {
            const value = String(children ?? "");
            const isBlock = value.includes("\n") || Boolean(codeClassName?.includes("language-"));

            if (isBlock) {
              return <code className={cn("font-mono", codeClassName)}>{children}</code>;
            }

            return (
              <code className={cn("rounded bg-secondary px-1 py-px font-mono text-[10px] text-foreground", codeClassName)}>
                {children}
              </code>
            );
          },
          img: ({ src, alt }) => (
            <img src={src} alt={alt ?? ""} className="my-3 max-h-96 max-w-full rounded border border-border/70 object-contain" />
          ),
          input: ({ checked, disabled, type }) => {
            if (type !== "checkbox") {
              return null;
            }

            return (
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled ?? true}
                readOnly
                className="mr-2 translate-y-[1px] accent-primary"
              />
            );
          },
          details: ({ children }) => <details className="my-3 rounded border border-border/70 bg-card/35 px-3 py-2">{children}</details>,
          summary: ({ children }) => <summary className="cursor-pointer font-semibold text-foreground">{children}</summary>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
