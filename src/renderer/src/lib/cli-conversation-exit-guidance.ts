import { translate } from '@/i18n/i18n'
import { agentLabel } from '../../../shared/ai-vault-session-filters'
import type { CliConversationRowAgent } from '../../../shared/structured-agent-cli-conversation-adoption'

export function cliConversationExitGuidance(agent: CliConversationRowAgent): string {
  return translate(
    'components.native-chat.resumeInNewChat.exitUnconfirmed',
    "Orca can't confirm {{agent}} has exited in its terminal. Stop what's running there or close the terminal, then try again.",
    { agent: agentLabel(agent) }
  )
}
