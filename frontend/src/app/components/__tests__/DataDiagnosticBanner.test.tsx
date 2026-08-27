import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataDiagnosticBanner } from '../DataDiagnosticBanner';

const MESSAGE =
  'This data was created by a newer version of Bearpaw (schema v2; this build supports v1).';

describe('DataDiagnosticBanner', () => {
  it('renders nothing when there is no data diagnostic', () => {
    const { container } = render(<DataDiagnosticBanner message={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('surfaces the backend message verbatim', () => {
    render(<DataDiagnosticBanner message={MESSAGE} />);
    // The backend message names the schema versions and the backup path; it is
    // the actionable part, so it must not be summarised away.
    expect(screen.getByText(MESSAGE)).toBeInTheDocument();
  });

  it('announces itself as an alert', () => {
    render(<DataDiagnosticBanner message={MESSAGE} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('can be dismissed', async () => {
    const user = userEvent.setup();
    render(<DataDiagnosticBanner message={MESSAGE} />);
    await user.click(screen.getByRole('button', { name: /dismiss data warning/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('is not conditioned on the scanner being disconnected', () => {
    // REGRESSION GUARD: the migration failure this exists for was invisible
    // precisely BECAUSE the scanner connected fine. The component takes only a
    // message and must never grow a connection_status gate — that is the bug.
    render(<DataDiagnosticBanner message={MESSAGE} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
