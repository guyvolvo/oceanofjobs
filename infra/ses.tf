# Fixes OTP codes landing in spam, reported live: Cognito's own default
# email sender has no domain reputation or SPF/DKIM alignment with this
# project at all. Once verified, aws_cognito_user_pool.main's
# email_configuration switches to sending through this identity instead
# -- but NOT until SES production access is granted (requested via
# `aws sesv2 put-account-details`, status PENDING as of this writing).
# Sandbox mode can only deliver to pre-verified recipient addresses; if
# Cognito switched to this identity while still in sandbox, sign-in would
# break for every real user instead of just landing in spam for some.
# Domain verification itself doesn't need production access, so this is
# safe to set up now and flip on the moment access is granted.

resource "aws_ses_domain_identity" "main" {
  domain = "guyvoloshin.com"
}

resource "aws_ses_domain_dkim" "main" {
  domain = aws_ses_domain_identity.main.domain
}

# Custom MAIL FROM domain: without this, the envelope sender (visible to
# some mail clients/spam filters as "via amazonses.com") is Amazon's own
# shared domain, not this project's -- a genuine part of why deliverability
# was poor. Needs its own MX + SPF TXT record in Cloudflare alongside the
# DKIM CNAMEs.
resource "aws_ses_domain_mail_from" "main" {
  domain           = aws_ses_domain_identity.main.domain
  mail_from_domain = "mail.${aws_ses_domain_identity.main.domain}"
}

# The site's own domain, so alert digests and contact replies come from
# alerts@oceanofjobs.com, the name in the inbox and the name on the site.
# guyvoloshin.com stays verified until nothing sends from it. The DNS
# records are in Cloudflare by hand (no Cloudflare provider here); the
# ses_site_dns_records output lists them.
resource "aws_ses_domain_identity" "site" {
  domain = var.domain_name
}

resource "aws_ses_domain_dkim" "site" {
  domain = aws_ses_domain_identity.site.domain
}

resource "aws_ses_domain_mail_from" "site" {
  domain           = aws_ses_domain_identity.site.domain
  mail_from_domain = "mail.${aws_ses_domain_identity.site.domain}"
}
