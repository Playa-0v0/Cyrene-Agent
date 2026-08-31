// User 面板业务逻辑：用户资料加载 / 保存 / 头像上传 / 性别选择
// 从 settings.ts 抽离。依赖 user DOM 引用（./dom）、timezone-options（白名单 + 校验）。
// 副作用导入：模块加载时执行事件绑定 + 初始加载。

import {
  avatarEl, uploadAvatarBtn,
  userDefaultCityInput, userNicknameInput, userCallPrefInput,
  userBirthdayInput, userTimezoneSelect, userGenderGroup,
} from "./dom";
import { TIMEZONE_OPTIONS, normalizeTimezoneOptionValue } from "../timezone-options";

const avatarImg = avatarEl?.querySelector("img") as HTMLImageElement | null;
const avatarPlaceholder = avatarEl?.querySelector("span") as HTMLElement | null;

function showAvatar(dataUrl: string | null): void {
  if (!dataUrl || !avatarEl) return;
  if (!avatarEl) return;
  let img = avatarEl.querySelector("img");
  if (!img) {
    img = document.createElement("img");
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.borderRadius = "50%";
    img.style.objectFit = "cover";
    avatarEl.appendChild(img);
  }
  img.src = dataUrl;
  if (avatarPlaceholder) avatarPlaceholder.style.display = "none";
}

async function loadUserProfile(): Promise<void> {
  try {
    const avatarDataUrl = await window.user?.getAvatar();
    if (avatarDataUrl) showAvatar(avatarDataUrl);
    if (uploadAvatarBtn) uploadAvatarBtn.disabled = false;
    // 加载用户字段（昵称/称呼偏好/生日/默认城市/时区）
    const profile = await window.user?.getProfile();
    if (profile) {
      if (userNicknameInput) userNicknameInput.value = String(profile.nickname ?? "");
      if (userCallPrefInput) userCallPrefInput.value = String(profile.callPreference ?? "");
      if (userBirthdayInput) userBirthdayInput.value = String(profile.birthday ?? "");
      if (userDefaultCityInput) userDefaultCityInput.value = String(profile.defaultCity ?? "");
      // 时区：白名单校验，空/非法/不在白名单都回退 FALLBACK_TIMEZONE，不直接用 ?? 兜底
      if (userTimezoneSelect) userTimezoneSelect.value = normalizeTimezoneOptionValue(profile.timezone);
      // 性别：标记当前选中的按钮
      const gender = String(profile.gender ?? "secret");
      if (userGenderGroup) {
        userGenderGroup.querySelectorAll(".gender-select__btn").forEach((btn) => {
          btn.classList.toggle("is-active", (btn as HTMLElement).dataset.gender === gender);
        });
      }
    }
  } catch {
    console.warn("[settings] load user profile failed");
  }
}

// 用户字段：失焦/回车保存（每个字段独立原子保存）
function bindUserProfileSave(input: HTMLInputElement | null, field: string, live = false): void {
  if (!input) return;
  let saveTimer: number | undefined;
  const save = (): void => {
    if (saveTimer !== undefined) window.clearTimeout(saveTimer);
    saveTimer = undefined;
    void window.user?.saveProfile({ [field]: input.value.trim() });
  };
  if (live) {
    input.addEventListener("input", () => {
      if (saveTimer !== undefined) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(save, 180);
    });
  }
  input.addEventListener("change", save);
  input.addEventListener("blur", save);
}

// ===== 事件绑定（模块加载时执行） =====
bindUserProfileSave(userNicknameInput, "nickname", true);
bindUserProfileSave(userCallPrefInput, "callPreference");
bindUserProfileSave(userBirthdayInput, "birthday");
// 默认城市复用上面的 saveCity（保持原逻辑）
if (userDefaultCityInput) {
  const saveCity = (): void => {
    const value = userDefaultCityInput.value.trim();
    void window.user?.saveProfile({ defaultCity: value });
  };
  userDefaultCityInput.addEventListener("change", saveCity);
  userDefaultCityInput.addEventListener("blur", saveCity);
}

// 时区：白名单填充 options；保存只接受白名单 value（select 只能选白名单项，天然受限）
if (userTimezoneSelect) {
  for (const opt of TIMEZONE_OPTIONS) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    userTimezoneSelect.appendChild(o);
  }
  userTimezoneSelect.addEventListener("change", () => {
    const raw = userTimezoneSelect.value;
    // 防御性二次校验：即便有人手动改 DOM，保存路径也只放行白名单 value
    const safe = normalizeTimezoneOptionValue(raw);
    if (safe !== raw) {
      userTimezoneSelect.value = safe;
      return; // 不发保存请求，等用户重新选
    }
    void window.user?.saveProfile({ timezone: safe });
  });
}

// 性别：三档按钮，点击切换并原子保存
if (userGenderGroup) {
  userGenderGroup.querySelectorAll(".gender-select__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const value = (btn as HTMLElement).dataset.gender;
      if (!value) return;
      userGenderGroup.querySelectorAll(".gender-select__btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      void window.user?.saveProfile({ gender: value });
    });
  });
}

if (uploadAvatarBtn) {
  uploadAvatarBtn.addEventListener("click", async () => {
    try {
      const result = await window.user?.uploadAvatar();
      if (result?.avatarPath) {
        const avatarDataUrl = await window.user?.getAvatar();
        if (avatarDataUrl) showAvatar(avatarDataUrl);
      }
    } catch (err) {
      console.error("[settings] upload avatar failed", err);
    }
  });
}

// 模块加载时拉一次配置
void loadUserProfile();
