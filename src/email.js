import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM = process.env.EMAIL_FROM || 'VajbAgent <onboarding@resend.dev>';

export async function sendWelcomeEmail(student) {
  if (!resend || !student.email) return;
  await resend.emails.send({
    from: FROM,
    to: student.email,
    subject: 'Dobrodošao na VajbAgent! Tvoj API ključ',
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px;">
        <h2 style="color:#FA7315;">Dobrodošao na VajbAgent!</h2>
        <p>Zdravo <strong>${student.name}</strong>,</p>
        <p>Tvoj nalog je kreiran. Evo tvog API ključa:</p>
        <div style="background:#1a1a1a;color:#fff;padding:14px 18px;border-radius:8px;font-family:monospace;font-size:14px;word-break:break-all;margin:16px 0;">
          ${student.key}
        </div>
        <p style="font-size:13px;color:#666;">Sačuvaj ovaj email — trebaće ti ključ za podešavanje ekstenzije u VS Code.</p>
        <p style="font-size:13px;color:#666;">Ako ikad izgubiš ključ, možeš ga ponovo dobiti na dashboardu klikom na "Zaboravio sam ključ".</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
        <p style="font-size:11px;color:#999;">VajbAgent — AI coding assistant za studente<br>Powered by Vajb &lt;kodiranje/&gt; Mentorski</p>
      </div>
    `,
  });
}

export async function sendRecoveryEmail(student) {
  if (!resend || !student.email) return false;
  try {
    await resend.emails.send({
      from: FROM,
      to: student.email,
      subject: 'VajbAgent — Tvoj API ključ',
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px;">
          <h2 style="color:#FA7315;">Recovery API ključa</h2>
          <p>Zdravo <strong>${student.name}</strong>,</p>
          <p>Zatražio si recovery svog API ključa. Evo ga:</p>
          <div style="background:#1a1a1a;color:#fff;padding:14px 18px;border-radius:8px;font-family:monospace;font-size:14px;word-break:break-all;margin:16px 0;">
            ${student.key}
          </div>
          <p style="font-size:13px;color:#666;">Ako nisi ti tražio ovaj email, možeš ga ignorisati.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
          <p style="font-size:11px;color:#999;">VajbAgent — AI coding assistant za studente</p>
        </div>
      `,
    });
    return true;
  } catch (err) {
    console.error('Recovery email send error:', err.message);
    return false;
  }
}

/**
 * Password-reset email. Contains a one-time link that lands on the SPA
 * (vajbagent.netlify.app by default) which reads the token from the URL and
 * posts it to /auth/reset-password.
 */
export async function sendPasswordResetEmail(student, resetLink) {
  if (!resend || !student.email || !resetLink) return false;
  try {
    await resend.emails.send({
      from: FROM,
      to: student.email,
      subject: 'VajbAgent — Resetovanje lozinke',
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:20px;">
          <h2 style="color:#FA7315;margin-bottom:16px;">Resetuj lozinku</h2>
          <p style="color:#333;line-height:1.55;">Zdravo <strong>${student.name || ''}</strong>,</p>
          <p style="color:#333;line-height:1.55;">Zatražio si resetovanje lozinke za VajbAgent. Klikni na dugme ispod da postaviš novu lozinku. Link važi <strong>1 sat</strong>.</p>
          <div style="text-align:center;margin:26px 0;">
            <a href="${resetLink}" style="display:inline-block;padding:13px 28px;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;font-weight:600;text-decoration:none;border-radius:10px;font-size:15px;">
              Postavi novu lozinku
            </a>
          </div>
          <p style="font-size:12px;color:#888;line-height:1.55;">Ako dugme ne radi, kopiraj ovaj link u browser:<br>
            <span style="word-break:break-all;color:#555;">${resetLink}</span>
          </p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
          <p style="font-size:12px;color:#888;line-height:1.55;">
            Ako nisi ti tražio reset lozinke, možeš slobodno ignorisati ovaj email — tvoja lozinka ostaje nepromenjena.
          </p>
          <p style="font-size:11px;color:#999;margin-top:14px;">VajbAgent — AI coding assistant za studente</p>
        </div>
      `,
    });
    return true;
  } catch (err) {
    console.error('Password reset email send error:', err.message);
    return false;
  }
}

export function isEmailConfigured() {
  return !!resend;
}
