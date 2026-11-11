import React from 'react';

type IconProps = React.SVGProps<SVGSVGElement>;

function decorativeIcon(props: IconProps): React.ReactElement {
  return React.createElement('svg', { ...props, 'aria-hidden': true, focusable: false });
}

export const AlertTriangle = decorativeIcon;
export const Check = decorativeIcon;
export const CheckCircle = decorativeIcon;
export const ChevronDown = decorativeIcon;
export const ChevronRight = decorativeIcon;
export const Clock = decorativeIcon;
export const Loader2 = decorativeIcon;
export const MoreHorizontal = decorativeIcon;
