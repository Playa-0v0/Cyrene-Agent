import { useMemo } from "react";
import { useTranslation } from "../../../i18n";
import 离线 from "../../../assets/status-float/离线.png";
import 聆听中 from "../../../assets/status-float/聆听中.png";
import 陪伴中 from "../../../assets/status-float/陪伴中.png";
import 提醒 from "../../../assets/status-float/提醒.png";

interface FloatItem {
  src: string;
  altKey: string;
  top: number;
  left: number;
  rotate: number;
  size: number;
  delay: number;
  duration: number;
}

// 只存 i18n key（非译文，可安全放模块顶层）；alt 文案在渲染时经 t() 求值。
const IMAGES = [
  { src: 离线, altKey: "statusFloat.offline" },
  { src: 聆听中, altKey: "statusFloat.listening" },
  { src: 陪伴中, altKey: "statusFloat.companion" },
  { src: 提醒, altKey: "statusFloat.remind" },
];

function randomRange(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

export function StatusFloat() {
  const { t } = useTranslation();
  const items = useMemo<FloatItem[]>(() => {
    const baseTops = [18, 38, 58, 78];
    return IMAGES.map((img, index) => {
      const isRight = index % 2 === 0;
      return {
        ...img,
        top: baseTops[index] + randomRange(-3, 3),
        left: isRight ? 54 + randomRange(-2, 2) : 8 + randomRange(-2, 2),
        rotate: randomRange(-90, 90),
        size: Math.round(randomRange(58, 64)),
        delay: randomRange(0, 4),
        duration: randomRange(3, 6),
      };
    });
  }, []);

  return (
    <div className="cy-status-float" aria-hidden="true">
      {items.map((item, index) => (
        <div
          key={index}
          className="cy-status-float__item"
          style={{
            top: `${item.top}%`,
            left: `${item.left}%`,
            width: `${item.size}px`,
            transform: `rotate(${item.rotate}deg)`,
          }}
        >
          <img
            src={item.src}
            alt={t(item.altKey)}
            style={{
              animationDelay: `${item.delay}s`,
              animationDuration: `${item.duration}s`,
            }}
          />
        </div>
      ))}
    </div>
  );
}
