/**
 * Renders the applicant-facing GDPR (article 17) deletion confirmation page.
 * Ported verbatim from dev-dashboard-v2 `recruitment/gdpr-delete-page.ts`.
 *
 * The page POSTs `DELETE /api/careers/applications/:token`; the delete endpoint
 * is served by {@link HiringService.applicantDeleteApplication}. `deleteUrl`
 * lets the host override the fetch target (default matches the original route).
 */
export function renderGdprDeletePage(
  token: string,
  opts: { deleteUrl?: string } = {},
): string {
  const url = opts.deleteUrl ?? `/api/careers/applications/${encodeURIComponent(token)}`;
  return `
    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <title>応募データの削除 / Delete Application</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.5; color: #111827; background: #f8f6f1; text-align: center; padding: 4rem 2rem; }
        .container { max-width: 480px; margin: 0 auto; background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
        h1 { font-size: 1.5rem; margin-bottom: 1rem; color: #1b3a6b; }
        p { margin-bottom: 2rem; color: #4b5563; }
        .buttons { display: flex; gap: 1rem; justify-content: center; }
        button { padding: 0.75rem 1.5rem; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; transition: opacity 0.2s; }
        .delete-btn { background: #c41e3a; color: white; }
        .delete-btn:hover { opacity: 0.9; }
        .cancel-btn { background: #e5e7eb; color: #374151; }
        .cancel-btn:hover { opacity: 0.9; }
      </style>
    </head>
    <body>
      <div class="container" id="main-container">
        <h1>応募データの削除</h1>
        <p>
          この操作は取り消せません。<br>
          本当に応募データ（個人情報を含む）を削除しますか？<br><br>
          Are you sure you want to delete your application data? This action cannot be undone.
        </p>
        <div class="buttons">
          <button class="cancel-btn" onclick="window.history.back()">キャンセル / Cancel</button>
          <button class="delete-btn" id="delete-btn">はい、削除します / Yes, Delete</button>
        </div>
      </div>
      <script>
        document.getElementById('delete-btn').addEventListener('click', async () => {
          const btn = document.getElementById('delete-btn');
          btn.disabled = true;
          btn.textContent = 'Deleting...';
          try {
            const res = await fetch('${url}', {
              method: 'DELETE'
            });
            if (res.ok) {
              document.getElementById('main-container').innerHTML = '<h1>削除が完了しました / Deleted</h1><p>ご提供いただいた応募データをすべて削除しました。</p><p>お問い合わせはサポートまでご連絡ください。</p>';
            } else {
              const data = await res.json();
              throw new Error(data.error || 'Failed to delete');
            }
          } catch (err) {
            alert('削除に失敗しました: ' + err.message);
            btn.disabled = false;
            btn.textContent = 'はい、削除します / Yes, Delete';
          }
        });
      </script>
    </body>
    </html>
  `;
}
