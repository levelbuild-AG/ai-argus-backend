import ReactMarkdown from 'react-markdown';
import { useLocalize } from '~/hooks';
import { TStartupConfig } from 'librechat-data-provider';

const brandedFooter = '[levelbuild](https://levelbuild.com/) Argus v2.21 - Break open data silos.';

function Footer({ startupConfig }: { startupConfig: TStartupConfig | null | undefined }) {
  const localize = useLocalize();
  const showLegalLinks = false; // Flip to true when ready; see docs/white-labeling.md
  const privacyPolicy = startupConfig?.interface?.privacyPolicy;
  const termsOfService = startupConfig?.interface?.termsOfService;

  const privacyPolicyRender =
    showLegalLinks &&
    privacyPolicy?.externalUrl && (
      <a
        className="text-sm text-green-500"
        href={privacyPolicy.externalUrl}
        target={privacyPolicy.openNewTab ? '_blank' : undefined}
        rel="noreferrer"
      >
        {localize('com_ui_privacy_policy')}
      </a>
    );

  const termsOfServiceRender =
    showLegalLinks &&
    termsOfService?.externalUrl && (
      <a
        className="text-sm text-green-500"
        href={termsOfService.externalUrl}
        target={termsOfService.openNewTab ? '_blank' : undefined}
        rel="noreferrer"
      >
        {localize('com_ui_terms_of_service')}
      </a>
    );

  return (
    <div className="align-end m-4 flex flex-col items-center gap-2 text-center" role="contentinfo">
      <ReactMarkdown
        className="text-sm text-gray-600 dark:text-gray-300"
        components={{
          a: ({ node: _n, href, children, ...otherProps }) => (
            <a
              className="text-green-500 underline"
              href={href}
              target="_blank"
              rel="noreferrer"
              {...otherProps}
            >
              {children}
            </a>
          ),
          p: ({ node: _n, ...props }) => <span {...props} />,
        }}
      >
        {brandedFooter}
      </ReactMarkdown>
      {(privacyPolicyRender || termsOfServiceRender) && (
        <div className="flex items-center gap-2">
          {privacyPolicyRender}
          {privacyPolicyRender && termsOfServiceRender && (
            <div className="border-r-[1px] border-gray-300 dark:border-gray-600" />
          )}
          {termsOfServiceRender}
        </div>
      )}
    </div>
  );
}

export default Footer;
