// workbenchFieldPrefs 纯逻辑单测：容错解析（坏值/缺字段/未知键/非 boolean）与 stringify 往返。
import { describe, it, expect } from "vitest";
import {
  DEFAULT_DISPLAY_FIELDS,
  DEFAULT_EDIT_FIELDS,
  DISPLAY_FIELDS,
  EDIT_FIELDS,
  parseDisplayFields,
  parseEditFields,
} from "./workbenchFieldPrefs";

describe("workbenchFieldPrefs 默认值", () => {
  it("显示字段默认全开", () => {
    expect(Object.values(DEFAULT_DISPLAY_FIELDS).every((v) => v === true)).toBe(true);
    expect(Object.keys(DEFAULT_DISPLAY_FIELDS).sort()).toEqual(DISPLAY_FIELDS.map((f) => f.key).sort());
  });
  it("编辑字段默认全开", () => {
    expect(Object.values(DEFAULT_EDIT_FIELDS).every((v) => v === true)).toBe(true);
    expect(Object.keys(DEFAULT_EDIT_FIELDS).sort()).toEqual(EDIT_FIELDS.map((f) => f.key).sort());
  });
});

describe("parseDisplayFields 容错", () => {
  it("null 回全默认", () => {
    expect(parseDisplayFields(null)).toEqual(DEFAULT_DISPLAY_FIELDS);
  });
  it("坏 JSON 回全默认", () => {
    expect(parseDisplayFields("{not json")).toEqual(DEFAULT_DISPLAY_FIELDS);
  });
  it("非对象（数组 / 原始值 / null 字面量）回全默认", () => {
    expect(parseDisplayFields("[]")).toEqual(DEFAULT_DISPLAY_FIELDS);
    expect(parseDisplayFields("42")).toEqual(DEFAULT_DISPLAY_FIELDS);
    expect(parseDisplayFields("null")).toEqual(DEFAULT_DISPLAY_FIELDS);
  });
  it("缺字段逐键补默认", () => {
    const parsed = parseDisplayFields(JSON.stringify({ project: false }));
    expect(parsed.project).toBe(false);
    // 其余键补默认 true。
    expect(parsed.tags).toBe(true);
    expect(parsed.note).toBe(true);
    expect(Object.keys(parsed).sort()).toEqual(DISPLAY_FIELDS.map((f) => f.key).sort());
  });
  it("未知键丢弃", () => {
    const parsed = parseDisplayFields(JSON.stringify({ project: false, bogus: false }));
    expect("bogus" in parsed).toBe(false);
  });
  it("非 boolean 值回默认", () => {
    const parsed = parseDisplayFields(JSON.stringify({ project: "no", tags: 0, due: null }));
    expect(parsed.project).toBe(true);
    expect(parsed.tags).toBe(true);
    expect(parsed.due).toBe(true);
  });
  it("单键关闭 JSON.stringify 往返保持", () => {
    const custom = { ...DEFAULT_DISPLAY_FIELDS, duration: false };
    expect(parseDisplayFields(JSON.stringify(custom))).toEqual(custom);
  });
});

describe("parseEditFields 容错", () => {
  it("null / 坏 JSON 回全默认", () => {
    expect(parseEditFields(null)).toEqual(DEFAULT_EDIT_FIELDS);
    expect(parseEditFields("{bad")).toEqual(DEFAULT_EDIT_FIELDS);
  });
  it("缺字段补默认、未知键丢弃、非 boolean 回默认", () => {
    const parsed = parseEditFields(JSON.stringify({ done: false, ghost: true, notes: 1 }));
    expect(parsed.done).toBe(false);
    expect(parsed.notes).toBe(true); // 非 boolean 回默认
    expect("ghost" in parsed).toBe(false);
    expect(Object.keys(parsed).sort()).toEqual(EDIT_FIELDS.map((f) => f.key).sort());
  });
  it("单键关闭 JSON.stringify 往返保持", () => {
    const custom = { ...DEFAULT_EDIT_FIELDS, notes: false };
    expect(parseEditFields(JSON.stringify(custom))).toEqual(custom);
  });
});
