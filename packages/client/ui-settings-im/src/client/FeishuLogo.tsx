/** Feishu brand mark, ported from the dsh-im Feishu channel avatar. */

/** Logo props, mirroring the ui-primitives IconProps convention. */
export interface FeishuLogoProps {
  /** Width/height in px (default 24). */
  size?: number
  /** Extra class for layout placement. */
  className?: string
}

/**
 * Render the three-segment teal/blue Feishu glyph.
 * @param props.size - width/height in px (default 24).
 * @param props.className - extra class for layout placement.
 * @returns the logo svg (aria-hidden; pair with text for accessibility).
 */
export function FeishuLogo({ size = 24, className }: FeishuLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      focusable="false"
      aria-hidden="true"
    >
      <path fill="#00D6B9" d="M7.2 4.5h7.6c1.2 0 2.1.55 2.7 1.58 1.05 1.8 1.55 3.45 1.58 4.95-2.04-.62-4.2-.15-6.22 1.45C11.3 9.7 9.42 7.04 7.2 4.5Z" />
      <path fill="#1456B8" d="M10.8 13.55c3.3-2.93 5.72-4.24 9.47-2.52-1.2 1.45-2.27 4.18-3.86 5.43-1.67 1.31-3.9.5-5.61-.64v-2.27Z" />
      <path fill="#3370FF" d="M4.4 8.35c3.47 3.61 7.25 6.1 10.33 5.7 1.06-.14 2.2-.72 3.4-1.72-1.04 2.65-2.6 4.8-5.06 6-2.46 1.2-5.56.52-7.42-.72A2.76 2.76 0 0 1 4.4 15.3V8.35Z" />
    </svg>
  )
}
