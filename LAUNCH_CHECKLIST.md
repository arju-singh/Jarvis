# SaaS Pre-Launch Checklist

**★ = launch-blocker** (don't go live without it) · plain items = do soon after launch.

## ✅ Legal & Compliance
- [ ] ★ Privacy Policy page
- [ ] ★ Terms & Conditions (Terms of Service)
- [ ] ★ Cookie consent banner (GDPR/EU — with a reject option, not just "accept")
- [ ] Refund / Cancellation policy (required by Stripe / most processors)
- [ ] GDPR data rights: export my data + delete my account (right to erasure)
- [ ] Data Processing Agreement (DPA) with sub-processors (Stripe, email, analytics)
- [ ] Company / business address + legal entity name displayed
- [ ] Age / eligibility statement if relevant (13+ / 16+)

## 🔐 Auth & Security
- [ ] ★ Signup / login flow tested
- [ ] ★ Email verification working
- [ ] ★ Password reset flow
- [ ] OAuth (Google, etc.) working if included
- [ ] ★ Rate limiting (brute-force protection on login / reset)
- [ ] ★ HTTPS / valid SSL on all pages (force redirect http → https)
- [ ] ★ Passwords hashed (bcrypt / argon2) — never plaintext
- [ ] ★ Secrets in env vars, not in the repo (.env gitignored)
- [ ] Session / JWT expiry + logout works
- [ ] Account lockout or CAPTCHA after repeated failures
- [ ] Security headers (HSTS, CSP, X-Frame-Options)
- [ ] Authorization checks (users can't access others' data — IDOR)

## 💳 Payment
- [ ] ★ Payment flow tested (success **and** failure / declined card)
- [ ] ★ Subscription lifecycle: Upgrade / Downgrade / Cancel
- [ ] ★ Webhooks handled (payment success, failed, subscription deleted)
- [ ] ★ Switch from Stripe **test** keys to **live** keys before launch
- [ ] Failed-payment / dunning handling (retry + notify)
- [ ] Invoices / receipts emailed to customer
- [ ] Taxes / GST handled if required (Stripe Tax)
- [ ] Free trial → paid transition tested (and what happens at trial end)
- [ ] Plan limits enforced server-side (not just hidden in UI)

## 📊 Analytics & Tracking
- [ ] User event tracking (signup, activation, key actions)
- [ ] Page tracking
- [ ] Conversion funnel (visit → signup → paid)
- [ ] Error / crash analytics
- [ ] Consent-gated (don't fire trackers before cookie consent — GDPR)

## 📣 Marketing Basics
- [ ] Submit to Google Search Console
- [ ] Submit to Bing Webmaster Tools (covers other engines)
- [ ] SEO basics: title / meta description, sitemap.xml, robots.txt
- [ ] Open Graph + Twitter card tags (link previews)
- [ ] Favicon + social share image
- [ ] Landing page with clear value prop + CTA + pricing

## 💬 Feedback Loop
- [ ] ★ Contact / Support email (and it actually receives mail)
- [ ] Bug report option
- [ ] Help / FAQ or docs page
- [ ] Feedback / feature-request channel

---

## 🖥️ Infrastructure & Reliability
- [ ] ★ Custom domain + DNS configured
- [ ] ★ Automated database backups (test a restore!)
- [ ] Error monitoring (Sentry or similar) with alerts
- [ ] Uptime monitoring (UptimeRobot / BetterStack)
- [ ] Staging / production environments separated

## 📧 Email Deliverability
- [ ] ★ Transactional email works (verify, reset, receipts land in inbox, not spam)
- [ ] SPF, DKIM, DMARC records set on your domain

## 📱 Quality / UX
- [ ] ★ Mobile responsive (test on a real phone)
- [ ] ★ Works in Chrome, Safari, Firefox
- [ ] Custom 404 / 500 error pages
- [ ] Loading / empty / error states for key screens
- [ ] Basic accessibility (alt text, keyboard nav, contrast)
- [ ] Performance check (Lighthouse / PageSpeed)

## 👋 Onboarding
- [ ] First-run / empty-state guidance so new users know what to do
- [ ] Welcome email

---

### Top launch-blockers (the ★ items that matter most)
1. SSL on every page
2. Live Stripe keys + webhooks tested (success **and** failure)
3. Email verification + deliverability (not landing in spam)
4. Automated database backups with a tested restore
5. Privacy Policy, Terms, and Refund policy pages — Stripe can suspend you without them
