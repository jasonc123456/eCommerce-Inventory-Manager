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
  magicLinkUrl,
  renderEmailCode,
  renderInvitation,
  renderMagicLink,
  renderSecurityNotice,
  TOKEN_QUERY_PARAMETER,
  type BrandContext,
  type EmailCodeContext,
  type InvitationContext,
  type MagicLinkContext,
  type RenderedMessage,
  type SecurityNoticeContext,
  type TemplateOverrides,
  type TokenCarrier,
} from './templates';
