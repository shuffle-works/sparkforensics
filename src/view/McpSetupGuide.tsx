import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const MCP_CLI_COMMAND = 'npx sparkforensics-mcp';

const MCP_CONFIG_JSON = `{
  "mcpServers": {
    "sparkforensics": {
      "command": "npx",
      "args": ["sparkforensics-mcp"]
    }
  }
}`;

/** Closed-by-default disclosure on the single-run landing screen: tells a
 * user how to point an MCP client (Claude Desktop/Claude Code) at this
 * repo's MCP server. End-user path only: no local-server /mcp route, no
 * server/-specific instructions. */
export function McpSetupGuide() {
  return (
    <Collapsible className="w-full">
      <CollapsibleTrigger className={cn(
        buttonVariants({ variant: 'outline' }),
        'tap-target-comfortable',
      )}>
        Use with an AI assistant (MCP)
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 flex w-full flex-col gap-2 text-sm">
        <p className="text-muted-foreground">
          This project exposes an MCP server so an AI assistant can diagnose a run directly, without going through this web UI.
        </p>
        <pre
          data-testid="mcp-config-snippet"
          className="overflow-x-auto rounded-md bg-muted p-2 text-xs whitespace-pre"
        >
          {MCP_CLI_COMMAND}
        </pre>
        <p className="text-muted-foreground">
          Or, in an MCP client config:
        </p>
        <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs whitespace-pre">
          {MCP_CONFIG_JSON}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
