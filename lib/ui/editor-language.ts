// Monaco language id for a file in the MID file browser. Monaco highlights every id below out of the box
// (basic-languages plus its json/css/html/typescript services); anything else opens as plain text.

const BY_EXT: Record<string, string> = {
  // markup / data
  xml: "xml", xsd: "xml", xsl: "xml", xslt: "xml", wsdl: "xml", svg: "xml", pom: "xml", plist: "xml", config: "xml",
  json: "json", jsonc: "json", json5: "json", map: "json",
  yaml: "yaml", yml: "yaml",
  ini: "ini", cfg: "ini", conf: "ini", properties: "ini", toml: "ini", env: "ini",
  md: "markdown", markdown: "markdown", mdx: "mdx", rst: "restructuredtext",
  html: "html", htm: "html", xhtml: "html", jsp: "html", vue: "html",
  css: "css", scss: "scss", sass: "scss", less: "less",
  graphql: "graphql", gql: "graphql", proto: "protobuf",
  // shells / scripting
  sh: "shell", bash: "shell", zsh: "shell", ksh: "shell",
  bat: "bat", cmd: "bat",
  ps1: "powershell", psm1: "powershell", psd1: "powershell",
  py: "python", pyw: "python",
  rb: "ruby", pl: "perl", pm: "perl", php: "php", lua: "lua", tcl: "tcl", r: "r",
  // JVM / .NET / native
  java: "java", groovy: "java", gradle: "java", jsx: "javascript",
  kt: "kotlin", kts: "kotlin", scala: "scala", sc: "scala", clj: "clojure", cljs: "clojure",
  cs: "csharp", csx: "csharp", vb: "vb", fs: "fsharp", fsx: "fsharp",
  c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  m: "objective-c", mm: "objective-c", swift: "swift", go: "go", rs: "rust", dart: "dart",
  // web
  js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  // data / infra
  sql: "sql", ddl: "sql", pgsql: "pgsql", mysql: "mysql",
  tf: "hcl", tfvars: "hcl", hcl: "hcl", bicep: "bicep",
  dockerfile: "dockerfile",
  ex: "elixir", exs: "elixir", jl: "julia", pas: "pascal", sol: "solidity", coffee: "coffee",
  hbs: "handlebars", handlebars: "handlebars", twig: "twig", liquid: "liquid", pug: "pug", cshtml: "razor",
  sv: "systemverilog", svh: "systemverilog", v: "systemverilog", wgsl: "wgsl",
}

const BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile", containerfile: "dockerfile",
  makefile: "shell", jenkinsfile: "java", vagrantfile: "ruby", gemfile: "ruby", rakefile: "ruby",
  ".bashrc": "shell", ".profile": "shell", ".env": "ini", ".gitignore": "ini", ".npmrc": "ini", ".editorconfig": "ini",
}

/** Monaco language id from a path (case-insensitive); "plaintext" when nothing matches (txt, logs, binaries). */
export function editorLanguage(path: string): string {
  const name = (path.split("/").pop() ?? "").toLowerCase()
  if (BY_NAME[name]) return BY_NAME[name]
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return name.startsWith(".") ? (BY_NAME[name] ?? "plaintext") : "plaintext"
  return BY_EXT[name.slice(dot + 1)] ?? "plaintext"
}

/** Code files open in the dark VS Code look regardless of the app theme. */
export const isCodeLanguage = (lang: string): boolean => lang !== "plaintext"
