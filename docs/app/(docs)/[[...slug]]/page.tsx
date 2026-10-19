import { source } from '@/lib/source';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';
import type { Metadata } from 'next';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { getPageMarkdownUrl, gitConfig } from '@/lib/shared';
import { openapi } from '@/lib/openapi';
import { OpenAPIPage } from '@/components/api-page';
import type { OpenAPIPageProps_Preloaded } from 'fumadocs-openapi/ui';

type Props = { params: Promise<{ slug?: string[] }> };

export default async function Page(props: Props) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;
  // Generated reference pages name the schema they need; it is read at
  // build time and baked into the page, so the export needs no server.
  const preloaded = page.data._openapi ? await openapi.preloadOpenAPIPage(page) : null;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="flex flex-row gap-2 items-center border-b pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/docs/content/docs/${page.path}`}
        />
      </div>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
            ...(preloaded && { OpenAPIPage: (p: Omit<OpenAPIPageProps_Preloaded, 'preloaded'>) => <OpenAPIPage {...p} {...preloaded} /> }),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return {
    title: `${page.data.title} · Ocean of Jobs docs`,
    description: page.data.description,
  };
}
