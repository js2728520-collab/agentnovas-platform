import type { MaintenanceEmailStatus } from "@/packages/contracts/src/riverton-ui";
import type {
  EmailConfigurationAction,
  EmailRecipientAction,
  EmailSecretOperation,
  EmailTestRecord,
  EmailTestRecipient,
} from "@/packages/notifications/src/email-service-management";

export type EmailServiceManagerProps = {
  status: MaintenanceEmailStatus;
  tests: EmailTestRecord[];
  recipients: EmailTestRecipient[];
  canManage: boolean;
  busy: boolean;
  message: string;
  translate?: (value: string) => string;
  formatDateTime: (value: string | null | undefined) => string;
  onConfigurationChange: (action: EmailConfigurationAction, reason: string) => Promise<boolean>;
  onSecretChange: (input: { operation: EmailSecretOperation;apiKey: string;webhookSecret: string;reason: string }) => Promise<boolean>;
  onRecipientCreate: (input: { email: string;label: string;reason: string }) => Promise<boolean>;
  onRecipientVerify: (input: { recipientId: string;code: string;reason: string }) => Promise<boolean>;
  onRecipientResend: (input: { recipientId: string;reason: string }) => Promise<boolean>;
  onRecipientChange: (input: { recipientId: string;action: EmailRecipientAction;reason: string }) => Promise<boolean>;
  onRecipientDelete: (input: { recipientId: string;reason: string }) => Promise<boolean>;
  onSendTest: (recipientId: string, reason: string) => Promise<boolean>;
  onRefresh: () => Promise<void>;
};
