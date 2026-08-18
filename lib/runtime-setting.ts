export function runtimeSetting(name: string) {
  return process.env[name];
}
