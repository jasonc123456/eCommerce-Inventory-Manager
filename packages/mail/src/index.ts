export {
  createMailer,
  describeFailure,
  type DeliveryFailure,
  type DeliveryOutcome,
  type Mailer,
  type MailerConfig,
  type OutboundMessage,
} from './mailer';

export {
  escapeHtml,
  renderEmailCode,
  renderInvitation,
  renderMagicLink,
  renderSecurityNotice,
  type BrandContext,
  type EmailCodeContext,
  type InvitationContext,
  type MagicLinkContext,
  type RenderedMessage,
  type SecurityNoticeContext,
  type TemplateOverrides,
} from './templates';
