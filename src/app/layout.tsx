import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "My Café Gourmand",
  description: "A collection of homemade recipes."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
