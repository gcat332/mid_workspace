"use client"

import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

// Renders one changelog entry's markdown body. The page parses CHANGELOG.md into
// per-version entries (preserving newlines); this turns each body back into real
// prose — bold, inline code, bullet lists, links — instead of a flattened run-on
// paragraph. Kept as a small client component so the page itself stays a server
// component that reads the file at request time.
const md: Components = {
  p: ({ children }) => (
    <p className="mt-2 text-[13px] leading-relaxed text-gray-600 first:mt-0 dark:text-neutral-300">{children}</p>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-gray-900 dark:text-neutral-100">{children}</strong>
  ),
  em: ({ children }) => <em className="italic text-gray-700 dark:text-neutral-200">{children}</em>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer"
      className="text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-500 dark:text-blue-400 dark:decoration-blue-700">
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11.5px] text-gray-800 dark:bg-neutral-900 dark:text-neutral-200">{children}</code>
  ),
  ul: ({ children }) => (
    <ul className="mt-2 space-y-1 pl-4 marker:text-gray-300 dark:marker:text-neutral-600 [&>li]:list-disc">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mt-2 list-decimal space-y-1 pl-5 marker:text-gray-400 dark:marker:text-neutral-500">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="ml-1 text-[13px] leading-relaxed text-gray-600 dark:text-neutral-300">{children}</li>
  ),
  h4: ({ children }) => (
    <h4 className="mt-3 text-[13px] font-semibold text-gray-900 dark:text-neutral-100">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="mt-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-neutral-400">{children}</h5>
  ),
  pre: ({ children }) => (
    <pre className="mt-2 overflow-x-auto rounded-lg bg-gray-900 p-3 text-[12px] leading-relaxed text-gray-100 dark:bg-black/50">{children}</pre>
  ),
  table: ({ children }) => (
    <div className="mt-2 overflow-x-auto"><table className="w-full text-[12px]">{children}</table></div>
  ),
}

export function ChangelogBody({ body }: { body: string }) {
  return (
    <div className="changelog-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={md}>{body}</ReactMarkdown>
    </div>
  )
}
