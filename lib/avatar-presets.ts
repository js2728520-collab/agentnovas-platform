export type AvatarPreset = {
  id: string;
  emoji: string;
  label: string;
};

export const AVATAR_PRESETS: AvatarPreset[] = [
  { id: "sunny-girl", emoji: "👩🏻‍🚀", label: "Sunny" },
  { id: "sky-boy", emoji: "👨🏻‍🚀", label: "Sky" },
  { id: "mint-girl", emoji: "👩🏼‍💻", label: "Mint" },
  { id: "byte-boy", emoji: "👨🏼‍💻", label: "Byte" },
  { id: "coral-girl", emoji: "👩🏽‍🎨", label: "Coral" },
  { id: "pixel-boy", emoji: "👨🏽‍🎨", label: "Pixel" },
  { id: "violet-girl", emoji: "👩🏾‍🔬", label: "Violet" },
  { id: "orbit-boy", emoji: "👨🏾‍🔬", label: "Orbit" },
  { id: "rose-girl", emoji: "👩🏿‍🚀", label: "Rose" },
  { id: "nova-boy", emoji: "👨🏿‍🚀", label: "Nova" },
  { id: "fox", emoji: "🦊", label: "Fox" },
  { id: "panda", emoji: "🐼", label: "Panda" },
  { id: "cat", emoji: "🐱", label: "Cat" },
  { id: "koala", emoji: "🐨", label: "Koala" },
  { id: "bear", emoji: "🐻", label: "Bear" },
  { id: "rabbit", emoji: "🐰", label: "Rabbit" },
  { id: "tiger", emoji: "🐯", label: "Tiger" },
  { id: "dog", emoji: "🐶", label: "Dog" },
  { id: "unicorn", emoji: "🦄", label: "Unicorn" },
  { id: "owl", emoji: "🦉", label: "Owl" },
  { id: "robot", emoji: "🤖", label: "Robot" },
  { id: "alien", emoji: "👽", label: "Alien" },
  { id: "astronaut", emoji: "🧑🏻‍🚀", label: "Astronaut" },
  { id: "detective", emoji: "🕵🏼", label: "Detective" },
  { id: "artist", emoji: "🧑🏽‍🎨", label: "Artist" },
  { id: "scientist", emoji: "🧑🏾‍🔬", label: "Scientist" },
  { id: "ninja", emoji: "🥷", label: "Ninja" },
  { id: "mage", emoji: "🧙", label: "Mage" },
  { id: "pilot", emoji: "🧑🏿‍✈️", label: "Pilot" },
  { id: "builder", emoji: "🧑🏼‍🔧", label: "Builder" },
];

export function avatarPresetValue(id: string) {
  return `preset:${id}`;
}

export function getAvatarPreset(value?: string | null) {
  const id = String(value ?? "").replace(/^preset:/, "");
  return AVATAR_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function isAvatarPreset(value?: string | null) {
  return Boolean(getAvatarPreset(value));
}
