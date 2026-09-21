export const metadata = { title: 'Next proto' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui', padding: 40 }}>{children}</body>
    </html>
  );
}
