import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none data-[variant=chrome]:w-full data-[variant=chrome]:items-end data-[variant=chrome]:justify-start data-[variant=chrome]:gap-1 data-[variant=chrome]:rounded-none data-[variant=chrome]:border-b data-[variant=chrome]:border-border data-[variant=chrome]:p-0 group-data-horizontal/tabs:data-[variant=chrome]:h-auto",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
        // Chrome-tab affordance: an open baseline (border-b above), not a boxed
        // pill, so the active trigger's own border + page background reads as selected.
        chrome: "bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:cursor-default disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:cursor-default aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        // Chrome tab (Trace): a flat label on the list's rule; the selected one
        // carries a 2px accent underline that sits on that rule (-mb-px).
        "group-data-[variant=chrome]/tabs-list:h-auto group-data-[variant=chrome]/tabs-list:flex-none group-data-[variant=chrome]/tabs-list:-mb-px group-data-[variant=chrome]/tabs-list:gap-2 group-data-[variant=chrome]/tabs-list:rounded-none group-data-[variant=chrome]/tabs-list:border-0 group-data-[variant=chrome]/tabs-list:border-b-2 group-data-[variant=chrome]/tabs-list:border-transparent group-data-[variant=chrome]/tabs-list:px-2.5 group-data-[variant=chrome]/tabs-list:py-2.5 group-data-[variant=chrome]/tabs-list:text-[0.8125rem] group-data-[variant=chrome]/tabs-list:font-medium group-data-[variant=chrome]/tabs-list:text-muted-foreground group-data-[variant=chrome]/tabs-list:hover:text-foreground",
        "group-data-[variant=chrome]/tabs-list:data-active:border-accent group-data-[variant=chrome]/tabs-list:data-active:bg-transparent group-data-[variant=chrome]/tabs-list:data-active:text-foreground group-data-[variant=chrome]/tabs-list:data-active:shadow-none dark:group-data-[variant=chrome]/tabs-list:data-active:border-accent dark:group-data-[variant=chrome]/tabs-list:data-active:bg-transparent",
        "tap-target-comfortable tap-target-comfortable--sm",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
