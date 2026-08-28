import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/utils';

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

/** Popover, not HoverCard: HoverCard is pointer-only by design (it listens for pointerenter/leave and
 *  nothing else), so on a touch device its content is unreachable — no hover, no card. Popover opens
 *  on activation, which a tap, a click AND Enter/Space all produce, and brings Escape + outside-press
 *  dismissal with it. Hover is layered on top by the consumer, so desktop still feels like a hover.
 *
 *  Portalled + collision-aware by default: the only consumer today sits in the bottom-left corner of
 *  a fixed 256px sidebar, so the card MUST be free to flip upward and slide rightward into the main
 *  pane instead of being clipped by the sidebar box or the viewport edge. */
const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'start', side = 'top', sideOffset = 8, collisionPadding = 8, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      side={side}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        'z-50 w-64 max-w-[calc(100vw-1rem)] rounded-md border bg-card p-3 text-card-foreground shadow-md outline-none',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        className
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent };
