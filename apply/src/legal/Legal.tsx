// The legal documents: /privacy, /terms and /refunds. The text is legal
// copy, kept word for word from frontend/<page>.html (scripts/nojs_check.py
// compares it with the live pages). consent.js owns the cookie settings
// button ([data-cookie-settings]) and the privacy page's #cookies anchor.
import type { ComponentType } from "react";
import { Page } from "../shell/Page";

function Privacy() {
  return (
    <>
  <h1>Privacy Policy</h1>
  <p className="updated">Last updated: October 2026</p>

  <p>Ocean of Jobs is a job board. You can browse, search and filter every listing without an account. This policy explains what data we collect when you use the site anonymously and when you sign in.</p>

  <h2>Anonymous use</h2>
  <p id="cookies"><strong>Cookies and analytics.</strong> Ocean of Jobs does not set first-party cookies or display advertising. If you accept analytics cookies, pages load Google Analytics, which sets its own cookies to measure visits and page views. If you decline, Google Analytics is never loaded and nothing is sent to Google. Your choice is kept in your browser, and you can change it at any time: <button type="button" data-cookie-settings="">cookie settings</button>.</p>
  <p><strong>Usage metrics.</strong> We record anonymous counts of visits, searches, listing views and apply clicks to track the site's growth. Each event contains only its type and, for searches, the search terms. No cookies, identifiers or IP addresses are attached. Events are aggregated into per-minute totals. Search terms are retained for 90 days, and terms that resemble an email address or phone number are discarded before storage.</p>
  <p><strong>Location.</strong> To show relevant local jobs, we use the country your connection originates from, as reported by our content delivery network. It is used only to render the current page and is not stored.</p>

  <h2>Browser storage</h2>
  <p>The following data is kept in your browser's local storage and is not sent to our servers: theme, filters, saved searches, panel layout, saved jobs, cached results, flags that prevent duplicate visit counts, and your response to the location prompt.</p>
  <p>Once you sign in, two exceptions apply. Your authentication tokens are sent with each request to verify your identity, and your saved jobs are synced to your account so they are available across devices.</p>

  <h2>Accounts</h2>
  <p><strong>Sign-in.</strong> You can sign in with Google, GitHub or a one-time code sent to your email. Amazon Cognito stores your sign-in record: your email address and, if you use Google, the name and profile picture Google provides.</p>
  <p><strong>Account data.</strong> Your account stores:</p>
  <ul>
    <li>Alerts (your saved filter criteria)</li>
    <li>Your profile: skills, seniority, preferred work location and arrangement, and digest schedule</li>
    <li>Saved jobs</li>
    <li>An overview generated from your profile</li>
  </ul>
  <p>Your profile does not include your name, phone number, employment history or resume unless you set up automatic applications (see below).</p>
  <p><strong>Resume parsing.</strong> If you use a resume to extract skills, it is processed entirely in your browser and never uploaded. Only the skills you choose to keep are saved.</p>
  <p><strong>Your resume for your AI agent.</strong> You can add your resume to your AI agent on the Auto apply page, after ticking a box to agree to this policy. The page reads the file in your browser and saves only its text, up to 8,000 characters, to your account. The file itself is never uploaded. We keep a record of when you agreed. The skills found in it are added to your search preferences. On Basic and Pro the text is also used to answer application questions for you, as described below. You can remove it at any time.</p>
  <p><strong>Email digests.</strong> Digests are sent only to verified email addresses. Each digest includes a link to disable the alert.</p>

  <h2>Personal access tokens</h2>
  <p>You can create personal access tokens for the MCP server, and connecting the extension creates one. For each token we store its name, its last four characters, when it was created and last used, and a one-way hash of it. The token itself is shown to you once and is not stored. Revoking a token deletes its record.</p>

  <h2>Terms, newsletter and waitlists</h2>
  <p>When you agree to our Terms of Service and Privacy Policy, we record the date and the version you agreed to.</p>
  <p>If you tick the newsletter box when you sign up, turn the newsletter on in your account settings, or join a paid plan's waitlist, we store your email address and that choice, and we may email you about new features and product updates. Joining a plan's waitlist subscribes you to the newsletter. Every email has a link to unsubscribe, and you can turn the newsletter off in your account settings at any time. Unsubscribing keeps you on the waitlist, so we can still tell you when that plan launches.</p>

  <h2>Browser extension and automatic applications</h2>
  <p>If you use automatic applications, your account also stores your application profile: contact details, links, work authorization, salary expectations, the answers you save for application questions, and, only if you choose to fill them in, demographic answers such as gender or veteran status. It is kept so the extension can use it on any computer you sign in on, and you can edit or delete it on your account page.</p>
  <p>By default, your resume file, Workday password and any AI provider key stay in the extension on your device, in local storage, and are never sent to us. If you choose cloud storage in the extension's settings, or upload your resume in your Auto apply settings, they are saved to your account instead, so the extension can use them on any computer you sign in on. The resume file is stored in Amazon S3 and the password and key in our database, all encrypted with a key held in AWS Key Management Service. Only the extension can read the password and key back; our website only shows that they are saved. Switching back to local storage deletes them from our servers. Separately, your resume's text is saved if you add it to your AI agent (see "Your resume for your AI agent" above). When the extension applies to a job, it sends your details and resume only to that employer's application form. If you add an AI provider key, the extension sends application questions and relevant profile details to that provider using your key. We record which jobs you applied to and how many applications you have used, so you can see your history and your plan's monthly limit can be counted. When you send a form with the extension's button on a site it has no dedicated filler for, the history keeps that page's title and address.</p>
  <p>On Basic and Pro, if you choose AI answers, a question you haven't answered is sent from our server to Cloudflare Workers AI together with the job's title, company and location and the parts of your application profile needed to answer it. Your name, email address, phone number and demographic answers are never sent. If you added your resume to your AI agent, up to 6,000 characters of its text are sent with the question so the answer can draw on it. An answer drafted while the extension applies for you is saved to your saved answers, where you can edit or delete it. Suggestions shown on a form you are filling in yourself are not saved.</p>
  <p>The extension reads pages only on Ocean of Jobs and on the job and application sites our listings come from, such as Greenhouse, Lever, Ashby, Workable, Comeet, Teamtailor, Workday and SmartRecruiters. Chrome lists each one under the extension's site access in chrome://extensions. On those sites it looks for an application form, or a job posting with an Apply button, in your browser and, if it finds one, shows a small button that fills it in when you click it. It applies on its own only through Greenhouse, Ashby and Workable. On any other site it reads a page only when you open the extension on that tab, to check for an application form in your browser, and fills it only when you click "Fill application".</p>
  <p>You can also let the extension see every site, in its settings or when you first use "Fill application" on a site outside that list. With that access it checks each page you open, in your browser, for an application form, so it can show the button on company careers pages and fill forms a page embeds from another site. On a page without an application form it does nothing else, and it sends nothing about the pages you visit to us or anyone else. You can take the access back at any time in the extension's settings or at chrome://extensions.</p>
  <p>After the extension fills in a form, it watches that tab for up to two hours to see whether you send the application with the site's own button. Meanwhile it looks at the data that tab sends to websites, in your browser, for a request that carries your email address, follows a press on the form's send button and is accepted by the site, and it checks the page for a confirmation. It then tells us only that the application was sent, so your history and the board show it as applied. It doesn't send us or anyone else the contents of those requests.</p>
  <p>The extension contains no analytics or tracking and does not collect your browsing history.</p>
  <p>Removing the extension deletes your resume, Workday password and AI provider key from your browser; anything in cloud storage stays on your account until you switch to local storage or delete your account. Removing your resume from your AI agent deletes its text from your account. Deleting your account deletes your application profile, application history and queue, your AI agent's settings, your resume's text, anything in cloud storage, and disconnects the extension.</p>

  <h2>Payments</h2>
  <p>Paid plans are sold by Dodo Payments, our Merchant of Record. Dodo Payments collects and processes your payment details, billing address and tax information under <a href="https://dodopayments.com/legal/privacy-policy" target="_blank" rel="noopener">its own privacy policy</a>, and we never see your card details. We give Dodo Payments your email address when you start a checkout. It tells us your plan, subscription status and billing dates, so we can give your account its plan.</p>

  <h2>Contact form</h2>
  <p>Messages submitted through the contact form are delivered to the maintainer by email, along with the name and email address you provide, so we can respond. They are not stored anywhere else.</p>

  <h2>Service providers</h2>
  <ul>
    <li>Cloudflare and Amazon CloudFront: request delivery</li>
    <li>Cloudflare Workers AI: AI answers to application questions, on Basic and Pro</li>
    <li>Amazon Web Services: application hosting</li>
    <li>Amazon DynamoDB: account storage</li>
    <li>Amazon Cognito: authentication</li>
    <li>Amazon SES: email delivery</li>
    <li>Amazon CloudWatch: anonymous metrics and search terms</li>
    <li>Google and GitHub: authentication, if you choose to sign in with them</li>
    <li>Dodo Payments: payments for paid plans</li>
  </ul>
  <p>We do not sell your data or share it with anyone beyond the providers listed above.</p>

  <h2>Logs</h2>
  <p>Cloudflare and CloudFront log requests, including IP addresses, for security and operational purposes. Our application server logs the requested URL, timestamp and user agent of each request. Because traffic reaches the server through a tunnel, it never receives your IP address. Server logs are retained for approximately one week.</p>

  <h2>Retention and deletion</h2>
  <p>Alerts are retained while active and removed immediately when deleted. Delete account removes your alerts, revokes your personal access tokens and clears your profile. Your sign-in record, saved jobs and generated overview are retained until you request their removal, at which point they are deleted in full. You may also request a copy of all data we hold about you.</p>

  <h2>Job listings</h2>
  <p>Listings are collected from companies' public career pages and public applicant tracking system APIs. This is publicly available corporate information, not user data.</p>

  <h2>Who is responsible</h2>
  <p>Ocean of Jobs is run by Guy Voloshin, Israel, who is the controller of the personal data described here. Contact: <a href="mailto:guyvoloshin@oceanofjobs.com">guyvoloshin@oceanofjobs.com</a>.</p>

  <h2>Why we use your data</h2>
  <p>We use account data, alerts, saved jobs and plan details to provide the service you signed up for. We use anonymous metrics and logs because we have a legitimate interest in keeping the service secure, working and improving. Dodo Payments processes payment data to complete your purchase and meet its legal obligations.</p>
  <p>Our servers and account storage are in Amazon Web Services' Israel region. Israel is recognised by the European Commission as giving adequate protection to personal data. Some providers listed above, such as Cloudflare, Google and Dodo Payments, may process data in other countries under their own safeguards.</p>

  <h2>Your rights</h2>
  <p>Wherever you live, you can ask us to:</p>
  <ul>
    <li>give you a copy of the personal data we hold about you, in a portable format;</li>
    <li>correct data that is wrong;</li>
    <li>delete your data;</li>
    <li>stop or limit a particular use of it.</li>
  </ul>
  <p>Email the address above. We reply within 30 days, and we may ask you to confirm the request from your account's email address. Depending on where you live, you can also complain to your data protection authority: in the EU or UK, the authority in your country; in Israel, the Privacy Protection Authority.</p>
  <p>We do not sell your personal information, and we will not treat you differently for using any of these rights.</p>

  <h2>Changes</h2>
  <p>Any changes to this policy will be posted on this page with an updated date. We'll email you about material changes before they take effect.</p>

  <h2>Contact</h2>
  <p>For privacy questions or data requests, email <a href="mailto:guyvoloshin@oceanofjobs.com">guyvoloshin@oceanofjobs.com</a>, open an issue on our <a href="https://github.com/guyvolvo/oceanofjobs" target="_blank" rel="noopener">GitHub repository</a> or use the <a href="/contact">contact page</a>.</p>
    </>
  );
}

function Terms() {
  return (
    <>
  <h1>Terms of Service</h1>
  <p className="updated">Last updated: October 2026</p>

  <p>These terms apply to your use of Ocean of Jobs, including the website at oceanofjobs.com, the REST API, the MCP server, and the browser extension.</p>
  <p>Ocean of Jobs is operated by Guy Voloshin, an individual based in Israel. In these terms, "we" refers to the operator of Ocean of Jobs, and "you" refers to anyone using the service.</p>
  <p>By using Ocean of Jobs, you agree to these terms. If you don't agree, please don't use the service.</p>

  <h2>1. The service</h2>
  <p>Ocean of Jobs collects job listings from employers' career pages and applicant tracking systems so you can search for jobs in one place.</p>
  <p>Job search, saved jobs, alerts, the REST API, and the MCP server are free. Automatic job applications through the Ocean of Jobs browser extension are described in section 5, and the limits for each plan in section 4.</p>
  <p>Job listings come from employers and their hiring systems. We don't create the listings and can't guarantee that they're accurate, complete, current, or still accepting applications. Check the employer's own website before applying.</p>

  <h2>2. Accounts</h2>
  <p>You'll need an account to use alerts, save jobs across sessions, and subscribe to a paid plan.</p>
  <p>Keep your account details accurate and your sign-in method secure. You're responsible for activity under your account. If you think someone else has accessed it, contact us using the details in section 15.</p>
  <p>You must be at least 16 years old and legally able to enter a binding agreement where you live.</p>

  <h2>3. Paid plans and billing</h2>
  <p>Payments are handled by Dodo Payments, our online reseller and Merchant of Record. Dodo Payments processes payments and handles refund requests. When you purchase a plan, you also agree to <a href="https://dodopayments.com/legal/buyer-terms" target="_blank" rel="noopener">Dodo Payments' buyer terms</a>.</p>
  <ul>
    <li><strong>Prices:</strong> The <a href="/pricing">pricing page</a> lists current prices and plan features. Prices are in US dollars unless checkout shows another currency. Applicable sales taxes and VAT are added at checkout.</li>
    <li><strong>Subscriptions:</strong> Paid plans renew automatically each month until you cancel.</li>
    <li><strong>Free trial:</strong> The Basic plan includes a 7-day free trial. You won't be charged during the trial. If you don't cancel before it ends, your subscription begins and the first payment is charged.</li>
    <li><strong>Cancellation:</strong> You can cancel under Billing in your account settings, through the link in your receipt, or by emailing us. Your subscription stays active until the end of the period you've paid for and won't renew afterward.</li>
    <li><strong>Introductory discount:</strong> Eligible customers receive 50% off their first monthly payment. The regular price applies to subsequent payments. The discount is limited to one use per customer.</li>
    <li><strong>Price changes:</strong> We'll email you at least 30 days before a price increase or other subscription price change takes effect. You can cancel before the new price applies.</li>
    <li><strong>Refunds:</strong> Our <a href="/refunds">Refund Policy</a> explains when and how to request a refund.</li>
  </ul>

  <h2>4. Application limits</h2>
  <p>Automatic application limits depend on your plan. The planned limits are:</p>
  <ul>
    <li><strong>Free:</strong> 10 applications per calendar month.</li>
    <li><strong>Basic:</strong> 100 applications per calendar month.</li>
    <li><strong>Pro:</strong> Up to 50 applications per day.</li>
  </ul>
  <p>Filling out an application without sending it doesn't count toward these limits. Every plan also includes AI answers to new application questions, up to 50 a month on Free, 300 on Basic and 3,000 on Pro.</p>
  <p>These limits apply once automatic applications become available for your plan. Check the <a href="/pricing">pricing page</a> for the current availability of this feature.</p>
  <p>An application counts when the extension submits it. Applications skipped or stopped before submission don't count. Unused applications don't roll over to the next month.</p>
  <p>The daily limit on Pro is intended to prevent excessive application activity. We may change plan limits with at least 30 days' notice by email.</p>

  <h2>5. Automatic applications</h2>
  <p>When available, the Ocean of Jobs browser extension can fill in and submit job applications on employers' websites using the profile information, documents, and answers you provide. You can review applications before submitting them or enable automatic submission for jobs you've chosen to apply to.</p>
  <p>By enabling submission, you authorize the extension to submit applications in your name according to your settings and selections.</p>
  <ul>
    <li><strong>Your responsibility:</strong> Make sure your profile, resume, and saved answers are accurate and truthful. Applications are submitted in your name, and you're responsible for their content.</li>
    <li><strong>No guaranteed results:</strong> We can't guarantee that an application will be received, reviewed, or answered, or that it will lead to an interview or job offer.</li>
    <li><strong>Employer websites:</strong> Applications are submitted through websites operated by employers and their hiring system providers. Those websites have their own terms and rules. Some employers don't accept automated applications and may reject or block submissions.</li>
    <li><strong>Your data:</strong> Your application profile and saved answers are stored in your Ocean of Jobs account so you can access them from different computers. Your resume file and any AI provider API key are stored in the extension on your device. The resume is sent to the employer you're applying to, while an API key and the information needed to answer application questions may be sent to the AI provider you choose. See our <a href="/privacy">Privacy Policy</a> for more information.</li>
    <li><strong>AI answers:</strong> On Basic and Pro, the extension can ask Ocean of Jobs to draft answers to questions you haven't answered yet. We draft them with Cloudflare Workers AI using your application profile, and save them to your saved answers. AI answers can be wrong; review your saved answers, because you're responsible for what's submitted.</li>
    <li><strong>Your own AI key:</strong> If you add your own API key, the extension may send application questions and relevant profile details to that provider to help draft answers. The provider's terms and usage charges apply to you.</li>
  </ul>

  <h2>6. Acceptable use</h2>
  <p>You agree not to use Ocean of Jobs to:</p>
  <ul>
    <li>Submit applications containing false information or apply in someone else's name without authorization.</li>
    <li>Spam employers with bulk, irrelevant, or repeated applications.</li>
    <li>Bypass subscription limits, daily usage limits, or API and MCP rate limits.</li>
    <li>Disrupt the service, attempt to gain unauthorized access, or access another person's account or data.</li>
    <li>Resell access to Ocean of Jobs or its data as a competing job board without our written permission.</li>
  </ul>
  <p>We may suspend or close accounts that violate these rules, as described in section 12.</p>

  <h2>7. REST API, MCP server, and access tokens</h2>
  <p>The REST API and MCP server are free to use, subject to the limits in our <a href="/docs">documentation</a>.</p>
  <p>Personal access tokens allow connected tools and AI assistants to access certain account features, such as your saved jobs. Keep your tokens private and treat them like passwords. You're responsible for activity performed using your tokens until you revoke them.</p>

  <h2>8. Your content and our intellectual property</h2>
  <p>You retain ownership of the information and files you provide, including your profile, saved answers, and documents. You allow us to store and process the information that reaches our servers as needed to operate the service.</p>
  <p>Ocean of Jobs source code is available under the <a href="https://polyformproject.org/licenses/noncommercial/1.0.0">PolyForm Noncommercial License 1.0.0</a>. You can use, modify and share that code for noncommercial purposes in accordance with the license. Commercial use needs our written permission.</p>
  <p>The license does not grant you ownership of the Ocean of Jobs name, logo, website design, or written content. You may not use our branding in a way that suggests your product is Ocean of Jobs or is endorsed by us.</p>
  <p>Job listings remain the property of the employers and other parties that publish them.</p>

  <h2>9. Privacy</h2>
  <p>Our <a href="/privacy">Privacy Policy</a> explains what personal data we collect, how we use it, and what rights you have. It forms part of these terms.</p>

  <h2>10. Availability and changes to the service</h2>
  <p>We do our best to keep Ocean of Jobs available, but we can't guarantee uninterrupted access or that every feature will always work without errors.</p>
  <p>Employers may change their websites or application forms, which can cause the browser extension to stop working on a particular site until it's updated.</p>
  <p>We may update, change, or discontinue features. If we discontinue a paid feature included in your plan, we'll refund the unused portion of your current paid period.</p>

  <h2>11. Disclaimers and liability</h2>
  <p>Ocean of Jobs is provided "as is" and "as available." To the extent permitted by law, we disclaim warranties, including implied warranties of fitness for a particular purpose.</p>
  <p>To the extent permitted by law, we're not liable for indirect or consequential losses, including missed job opportunities.</p>
  <p>Our total liability for claims relating to the service is limited to the amount you paid us during the 12 months before the event giving rise to the claim.</p>
  <p>Nothing in these terms excludes or limits consumer rights or other legal protections that can't be excluded or limited under applicable law.</p>

  <h2>12. Closing or suspending an account</h2>
  <p>You can stop using Ocean of Jobs and delete your account through your account settings. Deleting your account doesn't automatically cancel a subscription managed through Dodo Payments. Cancel your subscription separately to prevent future charges.</p>
  <p>We may suspend or close your account if you seriously or repeatedly violate these terms, if we're legally required to do so, or if your activity puts the service or other people at risk. Where reasonably possible, we'll notify you first and give you an opportunity to resolve the issue.</p>
  <p>If we close your paid account for a reason unrelated to a breach of these terms, we'll refund the unused portion of your current paid period.</p>
  <p>Sections 8, 11, and 14 continue to apply after your account ends.</p>

  <h2>13. Changes to these terms</h2>
  <p>We may update these terms from time to time. We'll publish the updated version on this page and change the revision date.</p>
  <p>We'll email you about material changes before they take effect. Using Ocean of Jobs after the effective date means you accept the updated terms.</p>
  <p>If a material change affects a paid plan, we'll email you at least 30 days before it takes effect.</p>

  <h2>14. Governing law and disputes</h2>
  <p>If you have a problem with the service, please contact us using the details in section 15. We'll try to resolve the issue with you within 30 days before either party takes legal action.</p>
  <p>These terms are governed by the laws of the State of Israel. The competent courts in Tel Aviv-Jaffa have jurisdiction, except where consumer protection laws applicable to you provide otherwise.</p>

  <h2>15. Contact</h2>
  <p>Ocean of Jobs is operated by Guy Voloshin, Israel.</p>
  <p>Email: <a href="mailto:guyvoloshin@oceanofjobs.com">guyvoloshin@oceanofjobs.com</a></p>
  <p>For payment and order questions, you can also contact Dodo Payments through the support link in your receipt.</p>
    </>
  );
}

function Refunds() {
  return (
    <>
  <h1>Refund Policy</h1>
  <p className="updated">Last updated: October 2026</p>

  <p>Payments for Ocean of Jobs subscriptions are handled by Dodo Payments, our reseller and Merchant of Record. Refunds are processed through Dodo Payments.</p>

  <h2>14-day refund window</h2>
  <p>You can request a full refund within 14 days of any payment, including your first payment and monthly renewals. You don't need to provide a reason.</p>

  <h2>Free trial</h2>
  <p>The Basic plan includes a 7-day free trial. You won't be charged during the trial. If you cancel before it ends, you won't be charged for the subscription.</p>

  <h2>After 14 days</h2>
  <p>Payments are generally non-refundable after the 14-day refund window, and we don't offer partial refunds for unused time in a billing period.</p>
  <p>You can cancel at any time. Your subscription will remain active until the end of the period you've already paid for.</p>
  <p>This doesn't affect any refund or cancellation rights you may have under applicable law.</p>

  <h2>If we discontinue a paid feature</h2>
  <p>If we discontinue a feature included in your paid plan, we'll refund the unused portion of your current billing period.</p>

  <h2>How to request a refund</h2>
  <p>You can request a refund in either of these ways:</p>
  <ul>
    <li>Email <a href="mailto:guyvoloshin@oceanofjobs.com">guyvoloshin@oceanofjobs.com</a> from the email address associated with your purchase.</li>
    <li>Use the support link in your Dodo Payments receipt.</li>
  </ul>
  <p>Refunds are returned to your original payment method. Your bank or payment provider may take several business days to show the refund.</p>
  <p>A refund cancels the subscription associated with that payment.</p>

  <h2>Your legal rights</h2>
  <p>This policy doesn't limit any rights you may have under the consumer protection laws that apply where you live, including any statutory rights to cancel a purchase or receive a refund.</p>

  <p>See also our <a href="/terms">Terms of Service</a> and <a href="/pricing">pricing page</a>.</p>
    </>
  );
}

export type Doc = "privacy" | "terms" | "refunds";
const DOCS: Record<Doc, ComponentType> = { privacy: Privacy, terms: Terms, refunds: Refunds };

// The landing page's reading column (.legal-doc on the old pages): a 760px
// measure, 72px under the bar, headings in the page face, text in the body grey.
const DOC = [
  "mx-auto max-w-[760px] text-body",
  "[&_h1]:m-0 [&_h1]:font-heading [&_h1]:text-[32px] sm:[&_h1]:text-[40px] [&_h1]:font-medium [&_h1]:leading-[1.1] [&_h1]:tracking-[-0.03em] [&_h1]:text-foreground",
  "[&_.updated]:mt-3 [&_.updated]:mb-7 [&_.updated]:text-sm [&_.updated]:text-dim",
  "[&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:font-heading [&_h2]:text-xl [&_h2]:font-medium [&_h2]:leading-[1.3] [&_h2]:tracking-[-0.01em] [&_h2]:text-foreground",
  "[&_p]:mt-0 [&_p]:mb-3.5 [&_p]:text-base [&_p]:leading-[1.65] [&_li]:text-base [&_li]:leading-[1.65]",
  "[&_ul]:mt-0 [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-5 [&_li+li]:mt-2",
  "[&_strong]:font-medium [&_strong]:text-foreground",
  "[&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-3 [&_a:hover]:text-link-hover",
  "[&_button]:cursor-pointer [&_button]:text-foreground [&_button]:underline [&_button]:underline-offset-3",
].join(" ");

export function Legal({ doc }: { doc: Doc }) {
  const Body = DOCS[doc];
  return (
    <Page footer>
      <div className="px-4 pt-8 pb-20 sm:px-10 sm:pb-28 min-[901px]:pt-[72px]">
        <article className={DOC}><Body /></article>
      </div>
    </Page>
  );
}
