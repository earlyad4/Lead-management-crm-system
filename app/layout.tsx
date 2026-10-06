import type { Metadata } from "next";
import "./globals.css";
import "./product.css";
import "./hardening.css";
import "./training.css";
import "./operations.css";

export const metadata: Metadata = {
  title: "Lead CRM — Lead management made clear",
  description: "A focused internal CRM for ownership, follow-ups, communication history, tasks, and pipeline visibility.",
  icons: {
    icon: "/brand/crm-logo.svg",
    shortcut: "/brand/crm-logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
