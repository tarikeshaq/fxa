/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { IsBoolean, IsEmail, IsOptional } from 'class-validator';
import { bind, ModelDataProvider } from '../../../lib/model-data';

export class SignupQueryParams extends ModelDataProvider {
  // 'email' will be optional once the index page is converted to React
  // and we pass it with router-state instead of a param, and `emailStatusChecked`
  // can be removed
  @IsEmail()
  @bind()
  email: string = '';

  @IsOptional()
  @IsBoolean()
  @bind()
  emailStatusChecked: boolean = false;
}
