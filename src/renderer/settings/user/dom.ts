// User 面板 DOM 引用
// 从 settings.ts 抽离。ESM 静态导入保证查询在 settings.ts 顶层代码之前执行。

export const avatarEl = document.getElementById("user-avatar-el") as HTMLElement | null;
export const uploadAvatarBtn = document.getElementById("upload-avatar-btn") as HTMLButtonElement | null;
export const userDefaultCityInput = document.getElementById("user-default-city") as HTMLInputElement | null;
export const userNicknameInput = document.getElementById("user-nickname") as HTMLInputElement | null;
export const userCallPrefInput = document.getElementById("user-call-pref") as HTMLInputElement | null;
export const userBirthdayInput = document.getElementById("user-birthday") as HTMLInputElement | null;
export const userTimezoneSelect = document.getElementById("user-timezone") as HTMLSelectElement | null;
export const userGenderGroup = document.getElementById("user-gender") as HTMLElement | null;
