// The top bar of the public pages is src/shell/Header.tsx now. These names
// stay for the pages that have not moved to src/shell yet (PublicPage,
// Footer), and the avatar is the workspace's account button.
import type { Who } from "./auth";

export { Brand, Header as SiteHeader } from "../shell/Header";

export function Avatar({ who, className = "" }: { who: NonNullable<Who>; className?: string }) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: avatarHtml(who.email, who.idToken) }} />;
}
