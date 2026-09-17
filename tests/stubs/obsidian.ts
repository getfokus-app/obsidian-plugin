/** Minimal stand-in so pure modules that import types from 'obsidian' resolve under Node. */
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class Notice {}
export class TFile {}
export const requestUrl = () => {
  throw new Error('requestUrl is not available in tests — use a fake FokusPort');
};
