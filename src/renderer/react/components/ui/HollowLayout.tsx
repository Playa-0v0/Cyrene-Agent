import type { ReactNode } from "react";

interface HollowLayoutProps {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  frameColor?: string;
  children?: ReactNode;
}

export function HollowLayout({
  left = 200,
  top = 50,
  right = 10,
  bottom = 10,
  frameColor = "#FBFAF9",
  children,
}: HollowLayoutProps) {
  return (
    <div
      className="hollow-layout"
      style={
        {
          "--left-width": `${left}px`,
          "--top-height": `${top}px`,
          "--right-width": `${right}px`,
          "--bottom-height": `${bottom}px`,
          "--frame-color": frameColor,
        } as React.CSSProperties
      }
    >
      <div className="hollow-top" />
      <div className="hollow-left" />
      <div className="hollow-right" />
      <div className="hollow-bottom" />
      <div className="hollow-center">{children}</div>
    </div>
  );
}
