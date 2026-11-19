import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "FinServe AI Voice Assistant",
  description: "Inbound customer enquiry and callback scheduling bot",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
