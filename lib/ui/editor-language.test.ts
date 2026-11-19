import { describe, expect, it } from "vitest"
import { editorLanguage, isCodeLanguage } from "./editor-language"

describe("editorLanguage", () => {
  it.each([
    ["agent/config.xml", "xml"], ["a.xsd", "xml"], ["a.wsdl", "xml"], ["a.xslt", "xml"],
    ["a.json", "json"], ["a.properties", "ini"], ["conf/wrapper-override.conf", "ini"], ["a.cfg", "ini"],
    ["a.sh", "shell"], ["a.bash", "shell"], ["a.bat", "bat"], ["a.cmd", "bat"], ["a.ps1", "powershell"],
    ["a.js", "javascript"], ["a.mjs", "javascript"], ["a.ts", "typescript"], ["a.tsx", "typescript"],
    ["a.py", "python"], ["a.java", "java"], ["a.groovy", "java"], ["a.kt", "kotlin"], ["a.go", "go"],
    ["a.rs", "rust"], ["a.rb", "ruby"], ["a.php", "php"], ["a.cs", "csharp"], ["a.cpp", "cpp"], ["a.h", "cpp"],
    ["a.sql", "sql"], ["a.html", "html"], ["a.css", "css"], ["a.scss", "scss"], ["a.yaml", "yaml"], ["a.yml", "yaml"],
    ["README.md", "markdown"], ["Dockerfile", "dockerfile"], ["a.tf", "hcl"], ["a.graphql", "graphql"], ["a.lua", "lua"],
    ["a.pl", "perl"], ["a.r", "r"], ["a.swift", "swift"], ["a.scala", "scala"], ["a.vb", "vb"], ["a.proto", "protobuf"],
    ["A.XML", "xml"],
  ])("%s → %s", (path, lang) => {
    expect(editorLanguage(path)).toBe(lang)
  })

  it("plain text, logs and unknown or missing extensions stay plaintext", () => {
    for (const p of ["notes.txt", "agent0.log.0", "agent/logs/wrapper.log", "LICENSE", "a.unknownext", "x.jar"]) {
      expect(editorLanguage(p)).toBe("plaintext")
    }
  })

  it("only real languages count as code", () => {
    expect(isCodeLanguage("xml")).toBe(true)
    expect(isCodeLanguage("plaintext")).toBe(false)
  })
})
