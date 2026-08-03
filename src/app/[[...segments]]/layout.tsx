import type { Metadata } from "next";
import "../globals.css";
import { getPageLocale } from "@/lib/recipe-routes";
import { siteDescription, siteName, siteUrl } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: siteName,
    template: `%s | ${siteName}`
  },
  description: siteDescription
};

type RootLayoutProps = Readonly<{
  children: React.ReactNode;
  params: Promise<{ segments?: string[] }>;
}>;

export default async function RootLayout({
  children,
  params
}: RootLayoutProps) {
  const { segments } = await params;
  const locale = getPageLocale(segments);

  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
