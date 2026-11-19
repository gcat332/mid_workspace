// Shared Tailwind class strings, copied from BSM AgentHub's lib/ui/classes.ts (same names, same values)
// so MidHub's forms, buttons and panels look identical. Pages import these instead of re-typing them.

// Text input / select / textarea (the single field look).
export const inputCls =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:bg-neutral-700 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-blue-500"

// Form field label: 12px/medium/muted.
export const labelCls = "block text-xs font-medium text-gray-600 dark:text-neutral-300 mb-1"

// Inline form/field error line.
export const errorTextCls = "text-xs text-red-500 dark:text-red-400"

// Panel/card surface (compose padding/divide-y/overflow at the call site).
export const cardCls = "bg-white dark:bg-neutral-800 rounded-xl border border-gray-200 dark:border-neutral-700 shadow-[0_1px_2px_rgba(23,35,50,0.06)]"

// Admin data tables: a card that scrolls the table sideways on phones; tinted header row with 12px/500 muted th;
// faint row hover. Machine values (times, IPs/CIDRs, URLs, IDs) add `font-mono` at the cell.
export const tableCardCls = `${cardCls} relative overflow-x-auto`
export const theadCls = "border-b border-gray-200 bg-gray-50 text-left text-xs font-medium text-gray-600 dark:border-neutral-700 dark:text-neutral-300"
export const trHoverCls = "hover:bg-gray-50"

// Selected row in sidebars/lists.
export const activeRowCls = "bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-medium"

// Secondary action: the outlined sibling of .btn-primary, same sizing rhythm and 10px radius.
export const ghostBtnCls =
  "px-4 py-2 text-sm font-medium rounded-[10px] border border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-700 transition-colors disabled:opacity-50"
