import type { Locale } from "@/content/schema";
import {
  contactFormFieldLimits,
  getContactFormBoundaryData
} from "@/lib/contact-form";

const copy: Record<Locale, {
  readonly email: string;
  readonly message: string;
  readonly name: string;
  readonly send: string;
  readonly subject: string;
  readonly title: string;
  readonly unavailable: string;
}> = {
  en: {
    email: "Email address",
    message: "Message",
    name: "Name",
    send: "Send message",
    subject: "Subject (optional)",
    title: "Send a message",
    unavailable: "The contact form is currently unavailable. Please try again later."
  },
  fr: {
    email: "Adresse e-mail",
    message: "Message",
    name: "Nom",
    send: "Envoyer le message",
    subject: "Objet (facultatif)",
    title: "Envoyer un message",
    unavailable: "Le formulaire de contact est actuellement indisponible. Veuillez réessayer plus tard."
  },
  ru: {
    email: "Адрес электронной почты",
    message: "Сообщение",
    name: "Имя",
    send: "Отправить сообщение",
    subject: "Тема (необязательно)",
    title: "Отправить сообщение",
    unavailable: "Форма обратной связи сейчас недоступна. Пожалуйста, повторите попытку позже."
  }
};

type ContactFormBoundaryProps = {
  readonly locale: Locale;
  readonly endpoint?: string;
};

export function ContactFormBoundary({
  endpoint,
  locale
}: ContactFormBoundaryProps) {
  const labels = copy[locale];
  const data = getContactFormBoundaryData(locale, endpoint);
  if (!data.available) {
    return (
      <section
        aria-label={labels.title}
        className="contact-form-boundary contact-form-unavailable"
        data-contact-form-boundary="unavailable"
      >
        <p>{labels.unavailable}</p>
      </section>
    );
  }

  return (
    <section
      className="contact-form-boundary"
      data-contact-form-boundary="available"
    >
      <form acceptCharset="UTF-8" action={data.endpoint} method="post">
        <fieldset>
          <legend>{labels.title}</legend>
          <input name="locale" type="hidden" value={data.locale} />
          <input name="returnUrl" type="hidden" value={data.returnUrl} />
          <p className="contact-form-honeypot" aria-hidden="true">
            <label htmlFor={`contact-website-${locale}`}>Website</label>
            <input
              autoComplete="off"
              id={`contact-website-${locale}`}
              name="website"
              tabIndex={-1}
              type="text"
            />
          </p>
          <p>
            <label htmlFor={`contact-name-${locale}`}>{labels.name}</label>
            <input
              autoComplete="name"
              id={`contact-name-${locale}`}
              maxLength={contactFormFieldLimits.name}
              name="name"
              required
              type="text"
            />
          </p>
          <p>
            <label htmlFor={`contact-email-${locale}`}>{labels.email}</label>
            <input
              autoComplete="email"
              id={`contact-email-${locale}`}
              inputMode="email"
              maxLength={contactFormFieldLimits.email}
              name="email"
              required
              type="email"
            />
          </p>
          <p>
            <label htmlFor={`contact-subject-${locale}`}>{labels.subject}</label>
            <input
              autoComplete="off"
              id={`contact-subject-${locale}`}
              maxLength={contactFormFieldLimits.subject}
              name="subject"
              type="text"
            />
          </p>
          <p>
            <label htmlFor={`contact-message-${locale}`}>{labels.message}</label>
            <textarea
              autoComplete="off"
              id={`contact-message-${locale}`}
              maxLength={contactFormFieldLimits.message}
              name="message"
              required
              rows={7}
            />
          </p>
          <button type="submit">{labels.send}</button>
        </fieldset>
      </form>
    </section>
  );
}
